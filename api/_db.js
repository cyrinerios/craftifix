// Prisma Postgres connection (Vercel Marketplace → Prisma Postgres, connected to this project).
// Uses the plain Postgres driver ("pg"); the table layout is also described in prisma/schema.prisma for Prisma Studio.
// Vercel adds the connection string as an environment variable when the database is connected to the project.
// Set STORAGE=blob in Vercel to fall back to the old Vercel Blob storage.
import pg from 'pg';

// Standard names first, then the same names with a custom prefix (e.g. CRAFTIFIX_ACCOUNTS_DATABASE_URL). Direct URLs before pooled ones.
const URL_NAMES = ['DATABASE_URL', 'POSTGRES_URL', 'DIRECT_URL', 'DIRECT_DATABASE_URL', 'POSTGRES_URL_NON_POOLING', 'DATABASE_URL_POOLED', 'POSTGRES_PRISMA_URL', 'PRISMA_DATABASE_URL'];
const clean = (v) => String(v || '').trim().replace(/^['"]|['"]$/g, '');
const isPg = (v) => /^postgres(ql)?:\/\//i.test(v);   // prisma+postgres:// (Accelerate) URLs need Prisma Client, so they are skipped
export function dbEnvName() {
  for (const n of URL_NAMES) if (isPg(clean(process.env[n]))) return n;
  const keys = Object.keys(process.env);
  for (const n of URL_NAMES) { const k = keys.find((x) => x.endsWith('_' + n) && isPg(clean(process.env[x]))); if (k) return k; }
  return null;
}
export function dbUrl() { const k = dbEnvName(); return k ? clean(process.env[k]) : null; }
export const useDb = () => String(process.env.STORAGE || '').toLowerCase() !== 'blob' && !!dbUrl();

let pool;
function getPool() {
  if (!pool) {
    let url = dbUrl();
    // Prisma Postgres needs TLS (certificate checked against the standard trusted authorities). Local test databases don't.
    const ssl = /@(localhost|127\.0\.0\.1)[:/]/.test(url) ? false : {};
    url = url.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '');
    pool = new pg.Pool({ connectionString: url, ssl, max: 3, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000 });
    pool.on('error', (e) => console.error('postgres pool error', e.message));
  }
  return pool;
}

export async function q(sql, params = []) {
  await ready();
  return (await getPool().query(sql, params)).rows;
}
// Run several statements in one transaction: fn receives a query function.
export async function tx(fn) {
  await ready();
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    const out = await fn((sql, params = []) => c.query(sql, params).then((r) => r.rows));
    await c.query('COMMIT');
    return out;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  user_id     TEXT PRIMARY KEY,
  email       TEXT NOT NULL DEFAULT '',
  business    TEXT NOT NULL DEFAULT '',
  plan        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT '',
  currency    TEXT NOT NULL DEFAULT 'AED',
  created_at  TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  data        JSONB NOT NULL,
  secrets     TEXT
);
CREATE INDEX IF NOT EXISTS accounts_email_idx ON accounts (lower(email));
CREATE TABLE IF NOT EXISTS products (
  user_id     TEXT NOT NULL,
  id          TEXT NOT NULL,
  position    INTEGER NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT '',
  price       NUMERIC(14,2),
  quantity    INTEGER,
  created_at  TIMESTAMPTZ,
  data        JSONB NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE TABLE IF NOT EXISTS orders (
  user_id        TEXT NOT NULL,
  id             TEXT NOT NULL,
  position       INTEGER NOT NULL,
  order_no       TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT '',
  total          NUMERIC(14,2),
  currency       TEXT NOT NULL DEFAULT '',
  customer_name  TEXT NOT NULL DEFAULT '',
  customer_email TEXT NOT NULL DEFAULT '',
  invoice_no     TEXT,
  created_at     TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ,
  data           JSONB NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS orders_order_no_idx ON orders (user_id, order_no);
CREATE TABLE IF NOT EXISTS inquiries (
  user_id        TEXT NOT NULL,
  id             TEXT NOT NULL,
  position       INTEGER NOT NULL,
  inq_no         TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT '',
  customer_name  TEXT NOT NULL DEFAULT '',
  customer_email TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ,
  data           JSONB NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE TABLE IF NOT EXISTS app_meta (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

// Create the tables once per server instance, then run the one-time copy from Vercel Blob (see _lib.js).
let readyP = null;
let onFirstReady = null;
export const setFirstRun = (fn) => { onFirstReady = fn; };
export function ready() {
  if (!readyP) {
    readyP = (async () => {
      await getPool().query(SCHEMA);
      if (onFirstReady) await onFirstReady((sql, params = []) => getPool().query(sql, params).then((r) => r.rows));
    })().catch((e) => { readyP = null; throw e; });
  }
  return readyP;
}
