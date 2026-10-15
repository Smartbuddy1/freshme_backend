import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import { readConfig } from '../src/config.js';

try {
  const env = process.env.NODE_ENV === 'production' ? process.env
    : dotenv.parse(readFileSync(new URL('../.env.production', import.meta.url)));
  const config = readConfig(env);
  if (config.NODE_ENV !== 'production') throw new Error('NODE_ENV must be production');
  if (/example\.|your-domain|localhost|127\.0\.0\.1/i.test(config.CLIENT_ORIGIN)) throw new Error('Set the real HTTPS domain in CLIENT_ORIGIN');
  if (/example\.|your-domain/i.test(config.ADMIN_EMAIL)) throw new Error('Set the owner ADMIN_EMAIL');
  if (!process.argv.includes('--allow-test-payments') && !config.RAZORPAY_KEY_ID.startsWith('rzp_live_')) throw new Error('Live launch requires Razorpay live keys; use --allow-test-payments for staging');
  console.log('Production configuration checks passed. Run db:check and complete a payment/printer test before opening the shop.');
} catch (error) {
  console.error(error.code === 'ENOENT' ? 'Create .env.production from .env.production.example first.' : error.message);
  process.exitCode = 1;
}
