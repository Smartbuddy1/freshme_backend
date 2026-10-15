import { connectDatabase, disconnectDatabase, transaction } from './database.js';
import { migrate } from './migrate.js';
import bcrypt from 'bcryptjs';
import { readConfig } from './config.js';
import { Admin, Product } from './models.js';
export const sampleProducts = [
  ['Kala Khatta','#7c3f9e','Classic slush'], ['Blue Raspberry','#009fe8','Fruit slush'], ['Green Apple','#70af28','Fruit slush'], ['Orange','#ff941c','Fruit slush'], ['Cola','#794f32','Classic slush'], ['Mango','#f4ba1b','Fruit slush']
].map(([name, flavorColor, category], sortOrder) => ({ name, flavorColor, category, sortOrder, available: true, deleted: false, sizes: [{ label: 'Small', price: 40 }, { label: 'Medium', price: 60 }, { label: 'Large', price: 80 }] }));
export async function seed(config) {
  await migrate();
  await transaction(async client => {
  await client.query('SELECT pg_advisory_xact_lock(706318241)');
  const email = config.ADMIN_EMAIL.toLowerCase();
  if (!(await client.query('SELECT 1 FROM fresh_me.admins WHERE email=$1', [email])).rowCount) await Admin.create({ email, passwordHash: await bcrypt.hash(config.ADMIN_PASSWORD, 12) }, client);
  for (const p of sampleProducts) if (!(await client.query('SELECT 1 FROM fresh_me.products WHERE name=$1', [p.name])).rowCount) await Product.create(p, client);
  });
}
if (process.argv[1] && new URL(import.meta.url).pathname.endsWith(process.argv[1].replaceAll('\\','/').split('/').pop())) {
  try { const c = readConfig(); await connectDatabase(c); await seed(c); console.log('Seed complete. Existing admin passwords and products were preserved.'); }
  catch (e) { console.error('Seed failed (' + (e.code || e.name) + '). Check configuration and database connectivity.'); process.exitCode = 1; }
  finally { await disconnectDatabase(); }
}
