import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { database, transaction } from './database.js';

function requireKnownHistory(rows, names) {
  const unknown=rows.filter(row=>!names.includes(row.name));
  if(unknown.length) {
    const error=new Error('Database migration history belongs to another release. Review the schema and migration history before upgrading; no migrations were applied.');
    error.code='MIGRATION_HISTORY_MISMATCH';
    throw error;
  }
}

export async function verifyMigrations() {
  const directory = new URL('../migrations/', import.meta.url);
  const { rows } = await database().query('SELECT name, checksum FROM fresh_me.schema_migrations');
  const names=(await readdir(directory)).filter(n => /^\d+.*\.sql$/.test(n));
  requireKnownHistory(rows,names);
  for (const name of names) {
    const sql = await readFile(new URL(name, directory), 'utf8');
    if (!rows.some(row => row.name === name && row.checksum === createHash('sha256').update(sql).digest('hex'))) {
      throw new Error('Database migration required');
    }
  }
}

export async function migrate() {
  await transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(706318240)');
    await client.query('CREATE SCHEMA IF NOT EXISTS fresh_me');
    await client.query('REVOKE ALL ON SCHEMA fresh_me FROM PUBLIC');
    await client.query('CREATE TABLE IF NOT EXISTS fresh_me.schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const directory = new URL('../migrations/', import.meta.url);
    const names=(await readdir(directory)).filter(n => /^\d+.*\.sql$/.test(n)).sort();
    const history=await client.query('SELECT name FROM fresh_me.schema_migrations');
    requireKnownHistory(history.rows,names);
    for (const name of names) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const { rows } = await client.query('SELECT checksum FROM fresh_me.schema_migrations WHERE name=$1', [name]);
      if (rows.length) {
        if (rows[0].checksum !== checksum) throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO fresh_me.schema_migrations(name, checksum) VALUES ($1,$2)', [name, checksum]);
    }
  });
}
