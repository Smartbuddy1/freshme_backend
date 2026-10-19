import EmbeddedPostgres from 'embedded-postgres';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { connectDatabase, disconnectDatabase, database } from '../src/database.js';
import { migrate } from '../src/migrate.js';

export async function testDatabase({beforeMigrate} = {}) {
  // Always isolated, never reads DATABASE_URL or fresheme_backned/.env.
  const root = fileURLToPath(new URL('../../.local/', import.meta.url));
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'postgres-test-'));
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer(); server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
  const password = randomBytes(24).toString('hex');
  const instance = new EmbeddedPostgres({ databaseDir: path.join(directory, 'data'), port, user: 'postgres', password,
    persistent: true, authMethod: 'scram-sha-256', postgresFlags: ['-h', '127.0.0.1'],
    onLog() {}, onError() {} });
  try {
    await instance.initialise(); await instance.start();
    await connectDatabase({ DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`, DATABASE_SSL: 'disable', NODE_ENV: 'test' });
    if(beforeMigrate)await beforeMigrate(database());
    await migrate();
  } catch (error) { await disconnectDatabase(); await instance.stop().catch(() => {}); throw error; }
  return { async stop() { await disconnectDatabase(); await instance.stop(); } };
}
export async function resetDatabase() {
  await database().query('TRUNCATE fresh_me.agent_pairings, fresh_me.agent_events, fresh_me.agent_commands, fresh_me.print_jobs, fresh_me.orders, fresh_me.products, fresh_me.counters, fresh_me.admins, fresh_me.refunds');
  await database().query("DELETE FROM fresh_me.settings WHERE _id<>'shop'");
  await database().query("DELETE FROM fresh_me.shops WHERE _id<>'shop'");
  await database().query("UPDATE fresh_me.shops SET enabled=true,name='Fresh Me' WHERE _id='shop'");
  await database().query(`UPDATE fresh_me.settings SET "agentKeyHash"=NULL,"keyVersion"=0,"batchSize"=5,"prepCopy"=false,"acceptingOrders"=true WHERE _id='shop'`);
}
