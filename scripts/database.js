import { readDatabaseConfig } from '../src/config.js';
import { connectDatabase, disconnectDatabase, database } from '../src/database.js';
import { migrate, verifyMigrations } from '../src/migrate.js';

try {
  const config = readDatabaseConfig();
  await connectDatabase(config);
  if (process.argv.includes('--migrate')) { await migrate(); console.log('Database migrations complete.'); }
  else {
    const { rows: [result] } = await database().query('SELECT current_database() AS database, current_user AS role, (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls');
    const readiness = { connected: true, ...result };
    try { await verifyMigrations(); readiness.migrationsCurrent = true; }
    catch (error) {
      if (error.code === '42P01' || error.message === 'Database migration required') readiness.migrationsCurrent = false;
      else throw error;
    }
    if (readiness.migrationsCurrent) {
      const { rows: [seed] } = await database().query("SELECT EXISTS(SELECT 1 FROM fresh_me.admins) AS admin_exists, EXISTS(SELECT 1 FROM fresh_me.products WHERE deleted=false) AS products_exist, EXISTS(SELECT 1 FROM fresh_me.settings WHERE _id='shop') AS shop_settings_exist");
      readiness.seed = seed;
      readiness.ready = seed.admin_exists && seed.products_exist && seed.shop_settings_exist;
    } else readiness.ready = false;
    console.log(JSON.stringify(readiness));
    if (process.argv.includes('--require-ready') && !readiness.ready) {
      console.error('Database initial setup is incomplete. Apply migrations and run seed with the intended owner login.');
      process.exitCode = 1;
    }
  }
} catch (error) {
  // Never print the connection string, password, or driver connection object.
  const hints = { ENETUNREACH: 'No route to database. For an IPv4-only network use the Supabase session pooler URL.', ENOTFOUND: 'Database host did not resolve.', '28P01': 'Database authentication failed. Check the rotated password.', SELF_SIGNED_CERT_IN_CHAIN: 'Set DATABASE_CA_CERT to the Supabase root certificate file.', UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Set DATABASE_CA_CERT to the Supabase root certificate file.' };
  const configError = error.code==='MIGRATION_HISTORY_MISMATCH' || /^(Invalid environment:|Production database requires)/.test(error.message) ? error.message : '';
  console.error(`Database check failed (${error.code || error.name}). ${configError || hints[error.code] || 'Check environment, network access and verified TLS settings.'}`);
  process.exitCode = 1;
} finally { await disconnectDatabase(); }
