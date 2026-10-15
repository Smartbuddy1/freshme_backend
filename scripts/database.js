import { readConfig } from '../src/config.js';
import { connectDatabase, disconnectDatabase, database } from '../src/database.js';
import { migrate } from '../src/migrate.js';

try {
  const config = readConfig();
  await connectDatabase(config);
  if (process.argv.includes('--migrate')) { await migrate(); console.log('Database migrations complete.'); }
  else {
    const { rows: [result] } = await database().query('SELECT current_database() AS database, current_user AS role, (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls');
    console.log(JSON.stringify({ connected: true, ...result }));
  }
} catch (error) {
  // Never print the connection string, password, or driver connection object.
  const hints = { ENETUNREACH: 'No route to database. For an IPv4-only network use the Supabase session pooler URL.', ENOTFOUND: 'Database host did not resolve.', '28P01': 'Database authentication failed. Check the rotated password.', SELF_SIGNED_CERT_IN_CHAIN: 'Set DATABASE_CA_CERT to the Supabase root certificate file.', UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Set DATABASE_CA_CERT to the Supabase root certificate file.' };
  console.error(`Database check failed (${error.code || error.name}). ${hints[error.code] || 'Check environment, network access and verified TLS settings.'}`);
  process.exitCode = 1;
} finally { await disconnectDatabase(); }
