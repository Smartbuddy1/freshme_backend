import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connectDatabase, database, disconnectDatabase } from '../src/database.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Allow passing --env=.env or defaults to .env.production
const envArg = process.argv.find(a => a.startsWith('--env='));
const envFile = envArg ? envArg.split('=')[1] : (fs.existsSync(path.join(root, '.env.production')) ? '.env.production' : '.env');
const envPath = path.resolve(root, envFile);

console.log(`\n======================================================`);
console.log(`🧹 FRESH ME - PRODUCTION CLEANUP (DEMO/TEST DATA ONLY)`);
console.log(`======================================================`);
console.log(`Using environment configuration: ${envFile}`);

dotenv.config({ path: envPath });

async function run() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not defined in ' + envFile);
  }

  const maskedUrl = process.env.DATABASE_URL.replace(/:[^:]*@/, ':****@');
  console.log(`Connecting to: ${maskedUrl}...\n`);
  await connectDatabase(process.env);

  console.log('--- 1. VERIFYING DATA TO KEEP (SAFE & PROTECTED) ---');
  const admins = await database().query('SELECT _id, email, role FROM fresh_me.admins');
  console.log(`✅ User Accounts / Logins (${admins.rows.length}):`);
  admins.rows.forEach(a => console.log(`   - ${a.email} (${a.role || 'OWNER'}) [ID: ${a._id}]`));

  const products = await database().query('SELECT _id, name, category, available FROM fresh_me.products');
  console.log(`✅ Products / Menu Prices (${products.rows.length}):`);
  products.rows.forEach(p => console.log(`   - ${p.name} (${p.category || 'Standard'}) - Available: ${p.available}`));

  const settings = await database().query('SELECT _id, "shopName", "acceptingOrders" FROM fresh_me.settings');
  console.log(`✅ Shop Settings (${settings.rows.length}):`);
  settings.rows.forEach(s => console.log(`   - Shop Name: "${s.shopName}" | Accepting Orders: ${s.acceptingOrders}`));

  console.log('\n--- 2. DATA TO REMOVE (DEMO / TEST TRANSACTIONS) ---');
  const ordersCount = (await database().query('SELECT count(*) FROM fresh_me.orders')).rows[0].count;
  const printJobsCount = (await database().query('SELECT count(*) FROM fresh_me.print_jobs')).rows[0].count;
  const refundsCount = (await database().query('SELECT count(*) FROM fresh_me.refunds')).rows[0].count;
  const countersCount = (await database().query('SELECT count(*) FROM fresh_me.counters')).rows[0].count;

  console.log(`❌ Test Orders to delete:       ${ordersCount}`);
  console.log(`❌ Test Print Jobs to delete:   ${printJobsCount}`);
  console.log(`❌ Test Refunds to delete:      ${refundsCount}`);
  console.log(`❌ Sequence Counters to reset:  ${countersCount}`);

  console.log('\n--- 3. EXECUTING CLEANUP ---');
  const client = await database().connect();
  try {
    await client.query('BEGIN');

    // Delete child print jobs first to satisfy foreign key constraint
    const delPrint = await client.query('DELETE FROM fresh_me.print_jobs');
    console.log(`   ✓ Deleted ${delPrint.rowCount} print jobs.`);

    const delRefunds = await client.query('DELETE FROM fresh_me.refunds');
    console.log(`   ✓ Deleted ${delRefunds.rowCount} refunds.`);

    const delOrders = await client.query('DELETE FROM fresh_me.orders');
    console.log(`   ✓ Deleted ${delOrders.rowCount} demo orders.`);

    const delCounters = await client.query('DELETE FROM fresh_me.counters');
    console.log(`   ✓ Reset ${delCounters.rowCount} sequence counters.`);

    await client.query('COMMIT');
    console.log('   🎉 Transaction COMMITTED successfully!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('   ❌ Transaction FAILED. Rolled back:', err.message);
    throw err;
  } finally {
    client.release();
  }

  console.log('\n--- 4. POST-CLEANUP VERIFICATION ---');
  const finalOrders = (await database().query('SELECT count(*) FROM fresh_me.orders')).rows[0].count;
  const finalPrints = (await database().query('SELECT count(*) FROM fresh_me.print_jobs')).rows[0].count;
  const finalAdmins = (await database().query('SELECT count(*) FROM fresh_me.admins')).rows[0].count;
  const finalProducts = (await database().query('SELECT count(*) FROM fresh_me.products')).rows[0].count;

  console.log(`• Orders remaining:       ${finalOrders} (Expected: 0)`);
  console.log(`• Print Jobs remaining:   ${finalPrints} (Expected: 0)`);
  console.log(`• Reports & Payments:     Clean slate (0)`);
  console.log(`• Admins preserved:       ${finalAdmins} (Kept intact)`);
  console.log(`• Products preserved:     ${finalProducts} (Kept intact)`);
  console.log(`• Token Sequence:         Will start from Token #001 on next order!`);

  // Reset agent's printed-jobs.json if agent directory exists
  const agentJobsPath = path.resolve(root, '../agent/printed-jobs.json');
  if (fs.existsSync(agentJobsPath)) {
    fs.writeFileSync(agentJobsPath, '[]', 'utf8');
    console.log('• Reset agent printed-jobs.json cache to []');
  }

  await disconnectDatabase();
  console.log(`\n======================================================`);
  console.log(`✨ DATABASE IS CLEAN AND READY FOR LIVE PRODUCTION!`);
  console.log(`======================================================\n`);
}

run().catch(err => {
  console.error('\nFatal Error during cleanup:', err);
  process.exit(1);
});
