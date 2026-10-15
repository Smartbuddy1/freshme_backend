import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url().refine(v => /^postgres(ql)?:\/\//.test(v), 'PostgreSQL URL required'),
  DATABASE_SSL: z.enum(['verify-full', 'disable']).default('verify-full'),
  DATABASE_CA_CERT: z.string().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  DATABASE_MIGRATE_ON_START: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  JWT_SECRET: z.string().min(32), AGENT_KEY: z.string().min(32),
  RAZORPAY_KEY_ID: z.string().regex(/^rzp_(test|live)_/), RAZORPAY_KEY_SECRET: z.string().min(1),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(16),
  AWS_REGION: z.string().regex(/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/),
  S3_BUCKET: z.string().min(3).max(63).regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/),
  S3_KEY_PREFIX: z.string().regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/).default('fresh-me/products'),
  AWS_ACCESS_KEY_ID: z.string().optional(), AWS_SECRET_ACCESS_KEY: z.string().optional(), AWS_SESSION_TOKEN: z.string().optional(),
  ADMIN_EMAIL: z.string().email(), ADMIN_PASSWORD: z.string().min(12),
  CLIENT_ORIGIN: z.string().url(), TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  LOG_LEVEL: z.enum(['fatal','error','warn','info','debug','trace','silent']).default('info'),
  DEMO_PAYMENT: z.preprocess(v => v === true || v === 'true' || v === '1', z.boolean()).default(false)
});
export function readConfig(env = process.env) {
  const result = schema.safeParse(env);
  if (!result.success) throw new Error(`Invalid environment: ${result.error.issues.map(i => i.path.join('.')).join(', ')}`);
  const c = result.data;
  if (c.NODE_ENV === 'production') {
    if (c.DATABASE_SSL !== 'verify-full') throw new Error('Production database requires verified TLS');
    if (c.DEMO_PAYMENT) throw new Error('DEMO_PAYMENT must not be enabled in production');
    if (!/[a-z]/.test(c.ADMIN_PASSWORD) || !/[A-Z]/.test(c.ADMIN_PASSWORD) || !/\d/.test(c.ADMIN_PASSWORD) || !/[^a-zA-Z\d]/.test(c.ADMIN_PASSWORD) || new Set(c.ADMIN_PASSWORD).size < 8) throw new Error('Production ADMIN_PASSWORD must be strong: 12+ characters, upper/lowercase, number and symbol');
    if (!c.CLIENT_ORIGIN.startsWith('https://')) throw new Error('Production CLIENT_ORIGIN must use HTTPS');
    for (const key of ['JWT_SECRET','AGENT_KEY','ADMIN_PASSWORD','RAZORPAY_KEY_ID','RAZORPAY_KEY_SECRET','RAZORPAY_WEBHOOK_SECRET','S3_BUCKET','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN']) {
      if (/replace|example|changeme|password|default/i.test(c[key])) throw new Error(`Replace placeholder ${key} before production`);
    }
  }
  if (Boolean(c.AWS_ACCESS_KEY_ID) !== Boolean(c.AWS_SECRET_ACCESS_KEY)) throw new Error('Set both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or leave both empty to use an IAM role');
  if (c.AWS_SESSION_TOKEN && !c.AWS_ACCESS_KEY_ID) throw new Error('AWS_SESSION_TOKEN requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY');
  const origin = new URL(c.CLIENT_ORIGIN);
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('CLIENT_ORIGIN must be an origin without a path or credentials');
  if (c.JWT_SECRET === c.AGENT_KEY) throw new Error('JWT_SECRET and AGENT_KEY must be independent');
  c.CLIENT_ORIGIN = origin.origin;
  return c;
}
