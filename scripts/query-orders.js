// Read-only diagnostics using the same verified TLS policy as the server.
import { readDatabaseConfig } from '../src/config.js';
import { connectDatabase, disconnectDatabase, database } from '../src/database.js';
try {
  await connectDatabase(readDatabaseConfig());
  const { rows } = await database().query('SELECT status,count(*)::integer AS count FROM fresh_me.orders GROUP BY status');
  console.log(JSON.stringify({ orderCounts: rows }));
} catch { console.error('Database diagnostics failed; check configuration and verified TLS connectivity.'); process.exitCode = 1; }
finally { await disconnectDatabase(); }
