import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export function createEnvironment(destination = new URL('../.env', import.meta.url)) {
  let template = readFileSync(new URL('../.env.pm2.example', import.meta.url), 'utf8');
  for (const key of ['JWT_SECRET', 'AGENT_KEY', 'RAZORPAY_WEBHOOK_SECRET']) {
    template = template.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${randomBytes(32).toString('hex')}`);
  }
  template = template.replace(/^ADMIN_PASSWORD=.*$/m, `ADMIN_PASSWORD="Fm9!${randomBytes(24).toString('base64url')}"`);
  // Never rotate an existing deployment's credentials or overwrite its config.
  writeFileSync(destination, template, { flag: 'wx', mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    createEnvironment();
    console.log('Created private .env with independent JWT, agent, webhook and admin secrets.');
    console.log('Edit .env: DATABASE_URL, real Razorpay keys, S3 bucket/region and AWS access, ADMIN_EMAIL, CLIENT_ORIGIN. Confirm PORT=3103 is unused.');
    console.log('Keep .env out of Git. Copy only AGENT_KEY to the shop agent. Configure the same webhook secret in Razorpay.');
  } catch (error) {
    if (error.code === 'EEXIST') console.log('.env already exists; no settings or secrets were changed.');
    else { console.error(`Could not create .env (${error.code || error.name}). Check folder permissions.`); process.exitCode = 1; }
  }
}
