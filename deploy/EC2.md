# Deploy Fresh Me to EC2

This guide assumes Ubuntu 24.04 LTS, a single EC2 instance, a permanent domain,
and Supabase PostgreSQL. No AWS resources are created by these files.

## 1. Instance and domain

- Attach an Elastic IP and point the domain's DNS A record to it. Use a direct
  DNS record initially; this configuration assumes Caddy is the only proxy.
- Allow inbound TCP 80 and 443. Restrict SSH (22) to your own IP; alternatively
  use AWS Session Manager. UDP 443 is optional for HTTP/3.
- Do not open port 3000 or 5432 to the internet. Caddy reaches the application
  on its private Docker network; PostgreSQL is hosted on Supabase.
- Permit outbound DNS, HTTPS and PostgreSQL traffic. For a direct Supabase IPv6
  endpoint, both the host and container need working IPv6 routing. Otherwise
  copy the **Session pooler** connection string (port 5432) from Supabase Connect.
  The username and hostname differ from the direct URL; copy both exactly.
- Install Docker Engine and Compose from [Docker's Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/).
  Compose 2.30+ is required for raw environment-file handling. Enable Docker
  at boot: `sudo systemctl enable --now docker`.

## 2. Upload the project and configure secrets

Copy the contents of `fresheme_backned/` into `/opt/fresheme_backned`. Do not
upload `node_modules`, `.local`, or the Windows printer agent's local state.
The Docker build packages only the API. Host the frontend separately.

```bash
cd /opt/fresheme_backned
cp deploy/.env.example deploy/.env
# Only copy this template if a production file has not already been prepared:
test -f .env.production || cp .env.production.example .env.production
chmod 600 deploy/.env .env.production
nano deploy/.env
nano .env.production
```

Set `APP_DOMAIN` to the bare hostname and `ACME_EMAIL` to your email in
`deploy/.env`. Set `CLIENT_ORIGIN` to the frontend HTTPS origin in the server file.
Do not include a path or trailing query string.

Create the production configuration from the included template. Fill the
database URL, independent JWT/agent/webhook secrets, strong admin password,
frontend origin, owner email, Razorpay keys and S3 settings using your accounts.
Do not put secret values in Git, Docker build arguments, or `VITE_` variables.
Keep values **unquoted** in the production file; Compose reads it in raw mode
so dollar signs in passwords are preserved.

If a credential has been exposed, rotate it before deploying. Encode only the password
component (`@` becomes `%40`, `#` becomes `%23`, `%` becomes `%25`).

The application verifies database TLS using the bundled public Supabase CA.
Leave `DATABASE_SSL=verify-full`. A custom CA can be mounted into the container
and referenced with `DATABASE_CA_CERT`; never disable verification.

Use an application-specific PostgreSQL role for runtime access when possible.
It needs USAGE on `fresh_me` and SELECT/INSERT/UPDATE/DELETE on its tables.
The first migration needs schema/table creation rights; run migrations with
the owner role before restricting the runtime role. Migrations run at startup
too, so the runtime role must be able to read `schema_migrations` and own the
schema for the existing startup migration strategy. For strict separation,
use the dedicated migration procedure described below.

## 3. Deploy and initialize

```bash
cd /opt/fresheme_backned
sudo bash deploy/deploy.sh
```

The script builds the image, checks production configuration, applies versioned
migrations, seeds six drinks and the initial admin, then starts Caddy and the
API. Seeding preserves existing product settings and admin passwords. Migrations
run transactionally under a database lock and detect modified applied files.
No destructive reset command is part of deployment.

For real Razorpay **test-mode** checkout before launch, use valid test keys and:

```bash
sudo bash deploy/deploy.sh --allow-test-payments
```

Demo payments are always disabled in production. Before opening the shop, switch
to live credentials and a Live Mode webhook, then rerun without that flag.

Caddy obtains and renews HTTPS certificates once DNS and ports 80/443 are ready.
The API is not published on a host port. Its container runs as a non-root user,
has a read-only filesystem, rotates logs, handles shutdown and restarts after
process failure or host reboot. The stack is designed for one API instance;
the current login/request rate limits are kept in process memory.

## 4. Connect payments and the shop printer

In Razorpay enable automatic capture. Create the webhook:

```text
https://YOUR_DOMAIN/api/webhooks/razorpay
```

Use the matching `RAZORPAY_WEBHOOK_SECRET` and subscribe to `payment.captured`,
`order.paid`, `payment.failed`, and `refund.processed`. Test and Live Mode webhook
settings are separate.

On the shop Windows laptop, set the permanent HTTPS API URL and production
`AGENT_KEY` in `agent/.env`, then follow the README in the separate agent folder.
The print agent runs on the shop laptop, not on EC2. Enable its autostart and
keep Windows awake while the shop is open.

Verify backend `/healthz` and `/api/menu`. On the separately hosted frontend,
verify `/` and `/admin`. Sign in with the production owner email and
generated password. Verify S3 image upload, **Test print**, a checkout,
one token and one receipt, served status, reconnecting the printer, and a refund.
Run a small live payment after switching keys. Put the permanent HTTPS `/` URL
on the customer QR code only after these checks pass.

## 5. Operations and updates

```bash
sudo docker compose --env-file deploy/.env ps
sudo docker compose --env-file deploy/.env logs --tail=100 app caddy
sudo docker compose --env-file deploy/.env exec app node scripts/database.js
```

For an update, retain the previous source revision/image, obtain a Supabase
backup, update the source and run `sudo bash deploy/deploy.sh`. Expect a brief
restart on this single-instance setup. Check health, login and checkout after
the update. Restore the previous image only if its schema remains compatible;
do not delete migration history or run down-migrations to roll back an app.

Enable Supabase backups/PITR as available on your plan and verify a restore into
a separate project. Monitor `/healthz`, EC2 disk/memory, container restarts and
Razorpay webhook failures. Docker health status alone does not restart a running
but unhealthy process; configure an external uptime alert. Database outages
return 503 from health checks; payment webhooks can retry after recovery.

Keep Caddy's persistent volumes: they contain certificates and renewal state.
Never run `docker compose down -v` during routine updates. Keep shop
`printed-jobs.json` when updating the Windows agent to preserve deduplication.

## Dedicated runtime role

For strict database privilege separation, set `DATABASE_MIGRATE_ON_START=false`
for the running API. Apply migrations as the database owner using
`npm run db:migrate` with owner credentials, then seed as the owner. Give the
runtime role USAGE on `fresh_me` and SELECT/INSERT/UPDATE/DELETE on application
tables, plus SELECT on `schema_migrations`. Configure its URL in the container.
Do not use the convenience deploy script with this split configuration because
that script performs migrations and seeding with the application URL.

References: [Supabase connections](https://supabase.com/docs/guides/database/connecting-to-postgres),
[TLS verification](https://supabase.com/docs/guides/platform/ssl-enforcement),
[Compose raw environment files](https://docs.docker.com/reference/compose-file/services/#env_file),
[Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https).
