import { connectDatabase, disconnectDatabase, transaction } from './database.js';
import { migrate } from './migrate.js';
import bcrypt from 'bcryptjs';
import { readSeedConfig, readDatabaseConfig } from './config.js';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { Admin, Product } from './models.js';
export const sampleProducts = [
  ['Kala Khatta','#7c3f9e','Classic slush'], ['Blue Raspberry','#009fe8','Fruit slush'], ['Green Apple','#70af28','Fruit slush'], ['Orange','#ff941c','Fruit slush'], ['Cola','#794f32','Classic slush'], ['Mango','#f4ba1b','Fruit slush']
].map(([name, flavorColor, category], sortOrder) => ({ name, flavorColor, category, sortOrder, available: true, deleted: false, sizes: [{ label: 'Small', price: 40 }, { label: 'Medium', price: 60 }, { label: 'Large', price: 80 }] }));
export async function seed(config, { menuOnly = false } = {}) {
  await migrate();
  await transaction(async client => {
  await client.query('SELECT pg_advisory_xact_lock(706318241)');
  if (!menuOnly) {
    const email = config.ADMIN_EMAIL.toLowerCase();
    if (!(await client.query('SELECT 1 FROM fresh_me.admins WHERE email=$1', [email])).rowCount) await Admin.create({ email, passwordHash: await bcrypt.hash(config.ADMIN_PASSWORD, 12),role:'SUPER_ADMIN',shopId:null }, client);
  }
  for (const p of sampleProducts) if (!(await client.query('SELECT 1 FROM fresh_me.products WHERE name=$1 AND "shopId"=$2', [p.name,'shop'])).rowCount) await Product.create({...p,shopId:'shop'}, client);
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const menuOnly = process.argv.includes('--menu-only'); const c = menuOnly ? readDatabaseConfig() : readSeedConfig(); await connectDatabase(c); await seed(c, { menuOnly }); console.log(menuOnly ? 'Menu seed complete. Existing products were preserved; no admin account was changed.' : 'Seed complete. Existing admin passwords and products were preserved.'); }
  catch (e) { const configurationIssue = /^(Invalid environment:|Production |Replace placeholder |Set the real owner )/.test(e.message) ? e.message : 'Check configuration and database connectivity.'; console.error('Seed failed (' + (e.code || e.name) + '). ' + configurationIssue); process.exitCode = 1; }
  finally { await disconnectDatabase(); }
}
