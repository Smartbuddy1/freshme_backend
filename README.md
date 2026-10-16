# Fresh Me backend

Copy this folder to EC2 as `fresheme_backned`. It contains the complete API,
SQL migrations, database certificate, dependency lockfile, env templates and
PM2/Nginx deployment files. No frontend, agent or parent package.json is needed.

For existing installations, read [the single-shop upgrade guide](deploy/SINGLE_SHOP_UPGRADE.md)
before applying migration 002 or updating the frontend/agents. Local fixes are not
automatically published to GitHub.

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
npm run setup:env
nano .env
npm run production:check -- --allow-test-payments
npm run db:check
npm run db:migrate
npm run seed
npm run db:check -- --require-ready
export FRESH_ME_NODE24="$(command -v node)"
pm2 start deploy/ecosystem.config.cjs --only fresh-me-api
curl --fail http://127.0.0.1:3103/healthz
```

Run each step only after the previous step succeeds. Fill the production env
before validation; omit `--allow-test-payments` when checking live credentials.

`setup:env` creates a private `.env` with generated JWT, agent, webhook and
admin secrets. It never overwrites an existing file. You still need your actual
database URL, Razorpay keys, S3 settings, owner email and frontend HTTPS origin.
Generated secrets are not printed and are never included in Git.

Database setup is independent of payment/image-storage configuration:
`npm run db:check` reports connection, TLS, migration and initial-data status.
`npm run seed` needs only the database settings and owner login. To initialize
only the default menu before choosing the owner account, run
`npm run seed -- --menu-only`. Repeating seeds preserves existing data.
`npm run db:check -- --require-ready` fails when migrations, owner account,
products or shop settings are missing; it never writes to the database.
The API still requires the complete production configuration before startup.

On a shared EC2, confirm port 3103 is unused with `sudo ss -ltnp` before
starting. Keep a separate Fresh Me process and do not run PM2 commands targeting
all applications or replace existing Node/Nginx configuration.

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
