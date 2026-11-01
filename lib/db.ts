import { Pool, type PoolClient } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __pgPool: Pool | undefined;
}

export function pool(): Pool {
  if (!globalThis.__pgPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    globalThis.__pgPool = new Pool({
      connectionString: url,
      max: Number(process.env.PG_POOL_MAX ?? 5),
      ssl: /sslmode=require|neon\.tech/.test(url) ? { rejectUnauthorized: false } : undefined,
    });
  }
  return globalThis.__pgPool;
}

export type Db = Pool | PoolClient;

/** Run fn inside a transaction. Retries serialization failures / deadlocks a few times. */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const c = await pool().connect();
    try {
      await c.query("begin");
      const out = await fn(c);
      await c.query("commit");
      return out;
    } catch (e: unknown) {
      await c.query("rollback").catch(() => {});
      const code = (e as { code?: string }).code;
      if ((code === "40001" || code === "40P01") && attempt < 4) continue;
      throw e;
    } finally {
      c.release();
    }
  }
}
