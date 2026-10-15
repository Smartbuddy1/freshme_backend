import { connectDatabase, disconnectDatabase } from './database.js';
import pino from 'pino';
import { readConfig } from './config.js';
import { migrate, verifyMigrations } from './migrate.js';
import { expireOrders } from './payments.js';
import { createApp } from './app.js';
import { createGateway } from './gateway.js';
let config;
try { config = readConfig(); } catch (e) { console.error(e.message); process.exit(2); }
const logger = pino({ level: config.LOG_LEVEL, redact: ['phone','password','headers','secret'] });
try { await connectDatabase(config); await (config.DATABASE_MIGRATE_ON_START ? migrate() : verifyMigrations()); await expireOrders(); }
catch (error) { logger.fatal({ code: error.code || 'DATABASE_STARTUP' }, 'Database startup failed; check connectivity, TLS certificate and migrations'); await disconnectDatabase(); process.exit(2); }
const gateway = createGateway(config, logger);
const app = createApp({ config, gateway, logger });
const server = app.listen(config.PORT, () => logger.info({ port: config.PORT }, 'Fresh Me is ready'));
const timer = setInterval(() => expireOrders().catch(() => logger.error('Order expiry sweep failed')), 60000);
let closing = false;
function shutdown(signal) {
  if (closing) return; closing = true; logger.info({ signal }, 'Shutting down'); clearInterval(timer);
  const deadline = setTimeout(() => process.exit(1), 15000).unref();
  server.close(async () => { await disconnectDatabase(); clearTimeout(deadline); process.exit(0); });
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
process.on('unhandledRejection', () => { logger.fatal('Unhandled rejection'); shutdown('error'); });
process.on('uncaughtException', () => { logger.fatal('Uncaught exception'); shutdown('error'); });
