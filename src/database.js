import pg from 'pg';
import { readFile } from 'node:fs/promises';

let pool;
export function database() {
  if (!pool) throw new Error('Database is not connected');
  return pool;
}
export async function connectDatabase(config) {
  const url = new URL(config.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must be PostgreSQL');
  // Driver URL parameters take precedence over Pool options. Configure all
  // driver options explicitly so ssl=false/sslmode cannot disable verification.
  url.search = '';
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (config.DATABASE_SSL === 'disable' && (!local || config.NODE_ENV === 'production')) throw new Error('TLS can only be disabled for a local development database');
  const ssl = config.DATABASE_SSL === 'disable' ? false : {
    rejectUnauthorized: true,
    ...(config.DATABASE_CA_CERT ? { ca: await readFile(config.DATABASE_CA_CERT, 'utf8') }
      : url.hostname.endsWith('.supabase.co') || url.hostname.endsWith('.supabase.com')
        ? { ca: await readFile(new URL('../certs/supabase-ca.crt', import.meta.url), 'utf8') } : {})
  };
  pool = new pg.Pool({ connectionString: url.toString(), ssl, max: config.DATABASE_POOL_MAX || 10,
    connectionTimeoutMillis: 10000, idleTimeoutMillis: 300000, statement_timeout: 15000,
    application_name: 'fresh-me' });
  pool.on('error', error => console.error(`Database idle connection failed (${error.code || 'connection error'})`));
  try { await pool.query('SELECT 1'); } catch (error) { await disconnectDatabase(); throw error; }
}
export async function disconnectDatabase() { const current = pool; pool = undefined; await current?.end(); }
export async function databaseHealthy() {
  try { await database().query('SELECT 1 FROM fresh_me.settings LIMIT 1'); return true; } catch { return false; }
}
export async function transaction(work) {
  const client = await database().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
