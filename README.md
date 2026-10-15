# Fresh Me backend

Copy this folder to EC2 as `fresheme_backned`. It contains the complete API,
SQL migrations, database certificate, dependency lockfile, env templates and
PM2/Nginx deployment files. No frontend, agent or parent package.json is needed.

To download this backend onto EC2:

```bash
git clone https://github.com/Smartbuddy1/freshme_backend.git fresheme_backned
cd fresheme_backned
```

The repository contains env templates only. Create the real `.env` on EC2;
it and installed dependencies are excluded by this folder's `.gitignore`.

Use Node 24. Install Linux dependencies on EC2; do not copy Windows node_modules.
Keep existing local env files for local use and configure a production `.env`
on EC2 from `.env.pm2.example` (preserve an existing EC2 `.env` during updates).

```bash
cd /home/ec2-user/fresheme_backned
npm ci --omit=dev
test -f .env || cp .env.pm2.example .env
chmod 600 .env
nano .env
npm run production:check -- --allow-test-payments
npm run db:check
npm run db:migrate
npm run seed
export FRESH_ME_NODE24="$(command -v node)"
pm2 start deploy/ecosystem.config.cjs --only fresh-me-api
curl --fail http://127.0.0.1:3103/healthz
```

Run each step only after the previous step succeeds. Fill the production env
before validation; omit `--allow-test-payments` when checking live credentials.

For this project's Amazon Linux EC2 and its existing applications, follow
[the full EC2 guide](deploy/EC2_AMAZON_LINUX.md), including the separate Node 24
runtime, Nginx, HTTPS and startup configuration. Other references:
[Ubuntu PM2 guide](deploy/EC2_BACKEND_PM2.md),
[environment settings](deploy/BACKEND_ENV.md),
[optional backend Docker deployment](deploy/EC2.md).

`npm start` runs the API directly. `/healthz` and `/api/menu` work without any
frontend files. `/` and `/admin` need the frontend hosted separately (or its
built `../frontend/dist` folder for local combined runs).

For development, install all dependencies with `npm ci`, configure `.env` from
`.env.example`, then use `npm run dev`. `npm test` uses an isolated test database.
