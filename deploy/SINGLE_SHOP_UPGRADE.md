# Single-shop Fresh Me upgrade

Deploy only this backend folder to EC2. The frontend and printer agent have their
own folders and deployments. This guide describes the local revision; confirm it
has actually been published to your Git remote before pulling it on EC2.

## Data upgrade

The application has one shop, one menu, one daily token sequence and one print
queue. There are no Machines/Users panels, assignments or manager roles.
Migration 003 removes the old routing columns and table. Existing single-shop
orders, products, tokens and print jobs are preserved. Former restricted staff
accounts are disabled so removing roles cannot grant them full admin access.
All existing admin sessions must sign in again.

Migrations 001 and 002 are immutable history: do not delete or edit them on an
existing installation. Migration 003 stops if it finds non-default business data.
That data needs a reviewed consolidation before upgrading; it is never silently
merged or discarded. Back up the database and test restoration before rollout.

Stop order acceptance in Fresh Me, let active receipts finish, and stop only
its agent and `fresh-me-api` process. Preserve private `.env` files, the previous
release and the agent's printed-job history. Do not restart all PM2 processes.
The other EC2 applications on ports 5001 and 5080 are independent.

From the actual Git checkout (previously
`/home/ec2-user/freshme_backend/freshme_backend`), after publication:

```bash
pwd
git status
git pull --ff-only origin main
node --version
npm ci --omit=dev
npm run production:check -- --allow-test-payments
npm run db:check
npm run db:migrate
npm run db:check -- --require-ready
export FRESH_ME_NODE24="$(command -v node)"
pm2 startOrRestart deploy/ecosystem.config.cjs --only fresh-me-api --update-env
curl --fail http://127.0.0.1:3103/healthz
```

Run commands individually and stop on failure. Use Node 24 without changing other
apps' interpreters. `FRESH_ME_NODE24` is a PM2 launcher variable. Confirm 3103 is
free or already belongs to Fresh Me. Preserve `.env`; keep
`DATABASE_MIGRATE_ON_START=false`, `DEMO_PAYMENT=false` and
`AGENT_FILE_MODE_ALLOWED=false` in production. Omit `--allow-test-payments` when
using live payment credentials. Do not reseed an existing installation routinely.

## Frontend and network

Publish the matching frontend. Checkout requires an Indian 10-digit mobile
number; name is optional. Customer URLs are `/` and `/order/ID`, with `/admin`
for administration. The `/freshme/` hosting prefix is also supported.

- Root hosting: configure `VITE_API_URL=/api`, serve the build's assets and
  forward `/api/` through the frontend HTTPS origin to the backend.
- Prefix hosting: the frontend uses `/freshme/api`. Forward that prefix to
  backend `/api/`. Follow the existing nginx examples in EC2_BACKEND_PM2.md or
  EC2_AMAZON_LINUX.md, including cookie-path rewriting when applicable.

Vite defaults to asset base `/freshme/`; use `VITE_BASE_PATH=/` for a root-only
host. Serve `index.html` as the fallback for customer/admin browser routes.
Set `CLIENT_ORIGIN` to the frontend origin and configure `TRUST_PROXY` for the
actual proxy chain. Admin sessions use secure, same-site cookies in production;
same-origin API proxying is the simplest separate frontend/backend arrangement.

Remote agents require trusted HTTPS, including IP addresses. An IP-based URL
needs a trusted certificate covering that IP. The backend's internal port may
use HTTP behind the HTTPS proxy. Do not disable certificate verification.

## Connect the printer agent

1. Install the Windows driver and print a Windows test page.
2. In admin **Settings → Printer agent**, generate a pairing code.
3. Stop the existing agent; run `npm ci --omit=optional`, then `npm run pair` in
   its folder. Enter the backend HTTPS URL and the code. Restart the agent.
4. Use `PRINTER_MODE=windows`, `PRINTER_NAME=auto`. If several eligible queues
   exist, select the intended one once. Printer credentials are not required.
5. Test a receipt, paid order, reprint and optional preparation copy.

The backend URL and key are saved in the agent's private `.env`. The code expires
after ten minutes and works once. Pairing replaces the shop's previous agent key.
The initial backend `AGENT_KEY` works only until pairing. Store keys privately;
they authenticate the computer to the order queue, not the printer. Run one agent
for this shop queue. Changing the installed printer does not require re-pairing.
Keep `.env`, `printed-jobs.json` and `printer-selection.json` when updating.

For file-output testing, use a completely separate non-production backend and
database with `AGENT_FILE_MODE_ALLOWED=true`, then set agent `PRINTER_MODE=file`.
File mode writes private `.bin`, `.html` and `.json` receipts and acknowledges
jobs, so never attach it to the live queue. Production rejects this backend flag.

## Release verification and recovery

Verify deployed login/cookies, pause/resume, Razorpay test checkout and webhooks,
pairing, physical printing and process restart. Local mocks do not certify these.
Review and rotate the credential formerly embedded in `scripts/query-orders.js`
if it was exposed; deleting a literal does not revoke it.

Keep Fresh Me paused if rollout fails. Roll forward with a compatible fix;
the pre-003 backend is not compatible with the new schema. Restoring a snapshot
requires reconciliation of all payments since that snapshot. Do not restore over
production as an automatic rollback step.
