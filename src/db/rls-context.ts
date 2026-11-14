import { AsyncLocalStorage } from 'async_hooks';

export interface RlsContext {
  role: string;
  driverId: number | null;
}

const rlsStorage = new AsyncLocalStorage<RlsContext>();

export function runWithRlsContext<T>(ctx: RlsContext, fn: () => T): T {
  return rlsStorage.run(ctx, fn);
}

export function getRlsContext(): RlsContext | undefined {
  return rlsStorage.getStore();
}
