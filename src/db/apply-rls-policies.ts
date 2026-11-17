import 'dotenv/config';
import { Pool } from 'pg';

interface PolicySpec {
  table: string;
  name: string;
  forCmd: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
  usingExpr?: string;
  withCheckExpr?: string;
}

const RLS_TABLES = ['drivers', 'financial_transactions'] as const;

const POLICY_SPECS: PolicySpec[] = [
  // drivers policies
  {
    table: 'drivers',
    name: 'drivers_admin_staff_select',
    forCmd: 'SELECT',
    usingExpr:
      "current_setting('app.user_role', true) IN ('system', 'super_admin', 'movement_manager', 'accountant')",
  },
  {
    table: 'drivers',
    name: 'drivers_admin_insert',
    forCmd: 'INSERT',
    withCheckExpr: "current_setting('app.user_role', true) IN ('system', 'super_admin')",
  },
  {
    table: 'drivers',
    name: 'drivers_admin_update',
    forCmd: 'UPDATE',
    usingExpr: "current_setting('app.user_role', true) IN ('system', 'super_admin')",
    withCheckExpr: "current_setting('app.user_role', true) IN ('system', 'super_admin')",
  },
  {
    table: 'drivers',
    name: 'drivers_admin_delete',
    forCmd: 'DELETE',
    usingExpr: "current_setting('app.user_role', true) IN ('system', 'super_admin')",
  },
  {
    table: 'drivers',
    name: 'drivers_self_select',
    forCmd: 'SELECT',
    usingExpr:
      "current_setting('app.user_role', true) = 'driver' AND id = CASE WHEN current_setting('app.driver_id', true) ~ '^[0-9]+$' THEN current_setting('app.driver_id', true)::integer ELSE NULL END",
  },
  // financial_transactions policies
  {
    table: 'financial_transactions',
    name: 'ft_admin_accountant_select',
    forCmd: 'SELECT',
    usingExpr: "current_setting('app.user_role', true) IN ('system', 'super_admin', 'accountant')",
  },
  {
    table: 'financial_transactions',
    name: 'ft_admin_accountant_insert',
    forCmd: 'INSERT',
    withCheckExpr: "current_setting('app.user_role', true) IN ('system', 'super_admin', 'accountant')",
  },
  {
    table: 'financial_transactions',
    name: 'ft_admin_accountant_update',
    forCmd: 'UPDATE',
    usingExpr: "current_setting('app.user_role', true) IN ('system', 'super_admin', 'accountant')",
    withCheckExpr: "current_setting('app.user_role', true) IN ('system', 'super_admin', 'accountant')",
  },
  {
    table: 'financial_transactions',
    name: 'ft_admin_accountant_delete',
    forCmd: 'DELETE',
    usingExpr: "current_setting('app.user_role', true) IN ('system', 'super_admin', 'accountant')",
  },
  {
    table: 'financial_transactions',
    name: 'ft_driver_self_select',
    forCmd: 'SELECT',
    usingExpr:
      "current_setting('app.user_role', true) = 'driver' AND driver_id = CASE WHEN current_setting('app.driver_id', true) ~ '^[0-9]+$' THEN current_setting('app.driver_id', true)::integer ELSE NULL END",
  },
];

/**
 * Ensures PostgreSQL Row Level Security is enabled and that every policy's
 * USING and WITH CHECK expressions match src/db/schema.ts.
 *
 * Note: drizzle-kit push omits USING/WITH CHECK clauses when creating policies,
 * so this helper repairs any null qual/with_check policies using SQL_ADMIN_USER
 * when admin credentials are available in the environment.
 */
export async function ensureRlsPoliciesApplied(): Promise<boolean> {
  const host = process.env.SQL_HOST;
  const database = process.env.SQL_DB_NAME;
  const adminUser = process.env.SQL_ADMIN_USER;
  const adminPassword = process.env.SQL_ADMIN_PASSWORD;

  if (!host || !database || !adminUser || !adminPassword) {
    return false;
  }

  const adminPool = new Pool({
    host,
    user: adminUser,
    password: adminPassword,
    database,
    max: 2,
    connectionTimeoutMillis: 15000,
  });

  try {
    const existingRes = await adminPool.query<{
      tablename: string;
      policyname: string;
      qual: string | null;
      with_check: string | null;
    }>(
      `SELECT tablename, policyname, qual, with_check
       FROM pg_policies
       WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
      [Array.from(RLS_TABLES)]
    );

    const existingMap = new Map<string, { qual: string | null; with_check: string | null }>();
    for (const row of existingRes.rows) {
      existingMap.set(`${row.tablename}.${row.policyname}`, {
        qual: row.qual,
        with_check: row.with_check,
      });
    }

    const rlsRes = await adminPool.query<{ tablename: string; rowsecurity: boolean }>(
      `SELECT tablename, rowsecurity
       FROM pg_tables
       WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
      [Array.from(RLS_TABLES)]
    );
    const allRlsEnabled =
      rlsRes.rows.length === RLS_TABLES.length && rlsRes.rows.every((r) => r.rowsecurity);

    const needsSync =
      !allRlsEnabled ||
      POLICY_SPECS.some((spec) => {
        const cur = existingMap.get(`${spec.table}.${spec.name}`);
        if (!cur) return true;
        if (spec.usingExpr && !cur.qual) return true;
        if (spec.withCheckExpr && !cur.with_check) return true;
        return false;
      });

    if (!needsSync) {
      return true;
    }

    const client = await adminPool.connect();
    try {
      await client.query('BEGIN');
      for (const tbl of RLS_TABLES) {
        await client.query(`ALTER TABLE "public"."${tbl}" ENABLE ROW LEVEL SECURITY;`);
      }

      for (const spec of POLICY_SPECS) {
        await client.query(`DROP POLICY IF EXISTS "${spec.name}" ON "public"."${spec.table}";`);
        const usingClause = spec.usingExpr ? ` USING (${spec.usingExpr})` : '';
        const withCheckClause = spec.withCheckExpr ? ` WITH CHECK (${spec.withCheckExpr})` : '';
        await client.query(
          `CREATE POLICY "${spec.name}" ON "public"."${spec.table}" AS PERMISSIVE FOR ${spec.forCmd} TO public${usingClause}${withCheckClause};`
        );
      }

      await client.query('COMMIT');
      console.info('[RLS] Synchronized PostgreSQL RLS policies on drivers and financial_transactions.');
      return true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('[RLS] Failed to synchronize RLS policies:', error);
    return false;
  } finally {
    await adminPool.end();
  }
}

const isDirectRun =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1]?.includes('apply-rls-policies');

if (isDirectRun) {
  ensureRlsPoliciesApplied()
    .then((ok) => {
      console.log('[RLS] apply-rls-policies completed:', ok);
      process.exit(ok ? 0 : 1);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
