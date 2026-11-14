import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import * as schema from './schema.ts';
import { getRlsContext } from './rls-context.ts';

declare global {
  var _postgresPool: Pool | undefined;
}

function wrapPoolWithRls(pool: Pool): Pool {
  const origQuery = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
  const origConnect = pool.connect.bind(pool) as () => Promise<PoolClient>;

  const applyRlsToClient = async (client: PoolClient, role: string, driverId: number | null) => {
    await client.query(
      "SELECT set_config('app.user_role', $1, true), set_config('app.driver_id', $2, true)",
      [role, driverId !== null ? String(driverId) : '']
    );
  };

  // Wrap pool.query for single-statement queries when an RLS context is active
  (pool as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (
    ...args: unknown[]
  ) => {
    const ctx = getRlsContext();
    if (!ctx) {
      return origQuery(...args);
    }

    const client = await origConnect();
    try {
      await client.query('BEGIN');
      await applyRlsToClient(client, ctx.role, ctx.driverId);
      const res = await (client.query as (...qArgs: unknown[]) => Promise<unknown>)(...args);
      await client.query('COMMIT');
      return res;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };

  // Wrap pool.connect for Drizzle db.transaction() calls
  (pool as unknown as { connect: () => Promise<PoolClient> }).connect = async () => {
    const client = await origConnect();
    const ctx = getRlsContext();
    if (!ctx) {
      return client;
    }

    const origClientQuery = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
    const origRelease = client.release.bind(client);

    (client as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (
      ...args: unknown[]
    ) => {
      const res = await origClientQuery(...args);
      const first = args[0];
      const sqlText =
        typeof first === 'string'
          ? first
          : typeof (first as { text?: string })?.text === 'string'
          ? (first as { text: string }).text
          : '';
      if (/^\s*begin\b/i.test(sqlText)) {
        await origClientQuery(
          "SELECT set_config('app.user_role', $1, true), set_config('app.driver_id', $2, true)",
          [ctx.role, ctx.driverId !== null ? String(ctx.driverId) : '']
        );
      }
      return res;
    };

    client.release = (err?: Error | boolean) => {
      (client as unknown as { query: unknown }).query = origClientQuery;
      client.release = origRelease;
      return origRelease(err);
    };

    return client;
  };

  return pool;
}

export const createPool = () => {
  if (!global._postgresPool) {
    const rawPool = new Pool({
      host: process.env.SQL_HOST,
      user: process.env.SQL_USER,
      password: process.env.SQL_PASSWORD,
      database: process.env.SQL_DB_NAME,
      max: 10,
      connectionTimeoutMillis: 15000,
    });

    rawPool.on('error', (err) => {
      console.error('Unexpected error on idle SQL pool client:', err);
    });

    global._postgresPool = wrapPoolWithRls(rawPool);
  }
  return global._postgresPool;
};

const pool = createPool();

export const db = drizzle(pool, { schema });
