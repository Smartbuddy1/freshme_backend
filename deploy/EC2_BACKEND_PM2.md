# Fresh Me backend on your existing EC2: PM2 + Nginx

This guide adds only the Fresh Me API alongside your two existing applications.
It assumes Ubuntu, host-installed Nginx, and an existing PM2 process manager.
Run commands on EC2 in Bash, as the same Linux user that owns the existing PM2
processes. Do not use `sudo pm2` if the existing applications use ordinary `pm2`.
Replace example domains, IP addresses, repository URLs, and SSH key paths.

The new process is `fresh-me-api`, its proposed port is `3103`, and its folder
is `$HOME/fresheme_backned` in the examples. If your existing projects use another
parent directory, use a new `fresheme_backned` folder there instead. Set
`FRESH_ME_DIR` to its absolute path once and use the same path throughout.
The database remains on Supabase. No React build, Docker,
Caddy, or printer-agent installation is needed on this EC2.

## 1. Inspect the existing server

Connect using your usual SSH login, for example from Windows PowerShell:

```powershell
ssh -i "C:\path\your-key.pem" ubuntu@YOUR_EC2_IP
```

On EC2:

```bash
whoami
pm2 list
node --version
sudo nginx -t
sudo ss -ltnp
free -h
df -h /
```

Confirm your two existing processes are visible and healthy. If they are not,
switch to their actual Linux deployment user before continuing. Confirm port
3103 is unused; otherwise choose another unused port and use it in both
`.env` and the new Nginx site. Check that memory/disk have capacity for
another Node process before installing dependencies.

Keep the existing Node runtime, PM2 installation, Nginx sites, and startup
service. Do not run `pm2 restart all`, `pm2 delete all`, `pm2 update`, or the
repository's original Docker deployment script. Take an EC2 snapshot or retain
your usual configuration backup before modifying the shared host.

## 2. Put the source in a separate folder

```bash
export FRESH_ME_DIR="$HOME/fresheme_backned"
mkdir -p "$FRESH_ME_DIR"
cd "$FRESH_ME_DIR"
```

Upload the contents of the local `fresheme_backned/` folder here over SFTP.
Do not upload Windows `node_modules` or development `.env` files. The backend
has its own package manifest and lockfile; no sibling folder is required.

```text
package.json
package-lock.json
src/
scripts/
migrations/
certs/
.env.pm2.example
deploy/ecosystem.config.cjs
deploy/nginx-backend.conf.example
```

## 3. Select Node 24 without replacing the other apps' runtime

If your current `node --version` is already v24, use:

```bash
export FRESH_ME_NODE24="$(command -v node)"
```

Otherwise install a separate, per-user Node 24 using an isolated nvm directory.
This block runs in a subshell and leaves your shell profile, normal nvm
installation, global Node, and PM2 installation unchanged. It needs curl, git,
and the normal Ubuntu archive utilities. If missing, install those utilities
using your normal server package-management procedure.

```bash
(
  set -e
  export NVM_DIR="$HOME/.fresh-me-nvm"
  mkdir -p "$NVM_DIR"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh -o "$NVM_DIR/install.sh"
    PROFILE=/dev/null bash "$NVM_DIR/install.sh"
  fi
  . "$NVM_DIR/nvm.sh" --no-use
  nvm install 24
)
export FRESH_ME_NODE24="$(NVM_DIR="$HOME/.fresh-me-nvm" bash -c '. "$NVM_DIR/nvm.sh" --no-use; nvm which 24')"
```

Verify it, then install only the server's production dependencies:

```bash
"$FRESH_ME_NODE24" --version
cd "$FRESH_ME_DIR"
PATH="$(dirname "$FRESH_ME_NODE24"):$PATH" npm ci --omit=dev
```

The version must start with v24. Keep this runtime installed: PM2 saves its
absolute executable path. In a new SSH session, set `FRESH_ME_NODE24` again
before running the setup commands or starting the ecosystem file.

## 4. Configure the backend

This PM2 guide uses **.env**, which the app reads automatically. The
separate `.env.production` file is used by the Docker deployment guide.

```bash
cd "$FRESH_ME_DIR"
PATH="$(dirname "$FRESH_ME_NODE24"):$PATH" npm run setup:env
chmod 600 .env
nano .env
```

Complete all values, including:

The full list and S3 access policy are in [BACKEND_ENV.md](BACKEND_ENV.md).
The S3 bucket can stay private. The app only reads/writes its product-image
prefix; it does not change bucket policies or other projects' objects.

```dotenv
NODE_ENV=production
PORT=3103
DATABASE_URL=YOUR_SUPABASE_POSTGRESQL_CONNECTION_STRING
DATABASE_SSL=verify-full
DATABASE_POOL_MAX=10
JWT_SECRET=YOUR_INDEPENDENT_RANDOM_SECRET
AGENT_KEY=YOUR_DIFFERENT_RANDOM_SECRET
RAZORPAY_KEY_ID=YOUR_REAL_RAZORPAY_TEST_KEY_ID
RAZORPAY_KEY_SECRET=YOUR_REAL_RAZORPAY_TEST_KEY_SECRET
RAZORPAY_WEBHOOK_SECRET=YOUR_SEPARATE_RANDOM_WEBHOOK_SECRET
AWS_REGION=ap-south-1
S3_BUCKET=YOUR_BUCKET_NAME
S3_KEY_PREFIX=fresh-me/products
AWS_ACCESS_KEY_ID=YOUR_DEDICATED_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY=YOUR_DEDICATED_SECRET_ACCESS_KEY
AWS_SESSION_TOKEN=
ADMIN_EMAIL=YOUR_ACTUAL_OWNER_EMAIL
ADMIN_PASSWORD=YOUR_STRONG_UNIQUE_PASSWORD
CLIENT_ORIGIN=https://api.yourdomain.com
TRUST_PROXY=1
LOG_LEVEL=info
DEMO_PAYMENT=false
```

Use the frontend domain for `CLIENT_ORIGIN` if known, for example
`https://yourwebsite.com`, without `/freshme`. Otherwise use your actual backend
origin temporarily and change it when connecting the frontend. This is only a
configuration value: no frontend is deployed by this step.

Generate an independent value for each secret by running this repeatedly:

```bash
"$FRESH_ME_NODE24" -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

JWT and agent secrets must each be at least 32 characters. The admin password
must have at least 12 characters, uppercase, lowercase, a digit, a symbol, and
eight distinct characters. Quote any `.env` value containing `#`, for example
`ADMIN_PASSWORD="your-actual-value"`; dotenv treats unquoted `#` as a comment.
Do not source this file in Bash or commit it to Git.

For IPv4-only EC2 connectivity, copy Supabase's **Session pooler** URL, port
5432, from Connect. Preserve its exact username/hostname and percent-encode the
password component. Keep verified TLS enabled. Use Fresh Me's intended database, not an
existing application's database. The first migration needs schema creation
rights. The seed preserves existing admin passwords and menu settings.

## 5. Validate and initialize

Run each command separately; continue only if it succeeds:

```bash
"$FRESH_ME_NODE24" --env-file=.env scripts/preflight.js --allow-test-payments
"$FRESH_ME_NODE24" scripts/database.js
"$FRESH_ME_NODE24" scripts/database.js --migrate
"$FRESH_ME_NODE24" src/seed.js
"$FRESH_ME_NODE24" scripts/database.js --require-ready
```

The test-payments flag allows real Razorpay Test Mode credentials. Production
never allows demo payment simulation. For a live launch, configure live keys
and rerun preflight without `--allow-test-payments`.

## 6. Start only Fresh Me

```bash
pm2 start deploy/ecosystem.config.cjs --only fresh-me-api
pm2 status
pm2 logs fresh-me-api --lines 50 --nostream
curl --fail http://127.0.0.1:3103/healthz
curl --fail http://127.0.0.1:3103/api/menu
```

Expect HTTP 200 and `{"ok":true}` from health, and products/settings from menu.
Confirm the original two processes remain healthy, then persist the complete
process list:

```bash
pm2 save
systemctl list-unit-files 'pm2-*'
```

Reuse the existing PM2 boot service. Check its status using the service name
reported above. If no boot service exists, run `pm2 startup`, review and execute
the exact command it prints for your current deployment user, then `pm2 save`.
Do not replace a working boot service for the other apps or reboot the shared
server just to test this installation.

## 7. Add a new backend domain to existing Nginx

Create a DNS A record, such as `api.yourdomain.com`, pointing to this EC2's stable
public IP. Use DNS-only mode initially if your DNS provider also offers a proxy.
This example assumes one public proxy: Nginx. Keep existing DNS records intact.

On standard Ubuntu Nginx installations, back up the shared configuration, then
create a new file only if its name is unused:

```bash
sudo cp -a /etc/nginx "/root/nginx-before-freshme-$(date +%Y%m%d-%H%M%S)"
sudo test ! -e /etc/nginx/sites-available/fresh-me-api && sudo cp deploy/nginx-backend.conf.example /etc/nginx/sites-available/fresh-me-api
```

If that name already exists, stop and inspect it before proceeding. Do not
overwrite another site's configuration. After creating the new file, edit it:

```bash
sudo nano /etc/nginx/sites-available/fresh-me-api
```

Replace `api.yourdomain.com` with the actual hostname. Match the port to
`.env`.

```bash
sudo ln -s /etc/nginx/sites-available/fresh-me-api /etc/nginx/sites-enabled/fresh-me-api
sudo nginx -t
```

Only after the configuration test succeeds:

```bash
sudo systemctl reload nginx
```

Use the existing certificate manager to issue HTTPS for the new hostname. If
your server already uses Certbot's Nginx plugin:

```bash
sudo certbot --nginx -d api.yourdomain.com
sudo nginx -t
sudo certbot renew --dry-run
```

If Certbot is not installed, follow its official Nginx instructions (linked
below) or use the certificate method already established on this EC2. Avoid
installing a second competing certificate manager. HTTPS is required for
production browser authentication and the printer agent.

Keep public TCP 80/443 available and SSH restricted to your access method.
Do not add public EC2 security-group rules for 3103 or PostgreSQL 5432. The app
currently listens on all host interfaces; restrict direct access to its port
with the existing security groups/firewall. Nginx reaches it via localhost.

## 8. Verify the public backend

```bash
curl --fail https://api.yourdomain.com/healthz
curl --fail https://api.yourdomain.com/api/menu
pm2 status
```

Also verify the existing two applications' public health URLs. `/` and `/admin`
may return `Client build missing` for this backend-only installation. That is
expected: use `/healthz` and `/api/menu` for backend checks. The admin API lives
under `/api/admin`; its browser interface will be on your later frontend.

In Razorpay, enable automatic capture and add:

```text
https://api.yourdomain.com/api/webhooks/razorpay
```

Use the matching webhook secret and subscribe to `payment.captured`,
`order.paid`, `payment.failed`, and `refund.processed`. Test and Live Mode need
separate webhook configuration. A browser GET to the webhook is not a webhook
test: it accepts signed POST requests. Real checkout and printer acceptance
tests remain pending until you connect the frontend and shop agent.

## 9. Later updates and frontend handoff

Update only Fresh Me's source, preserve `.env`, retain the previous
revision, and obtain a database backup before migrations. With `FRESH_ME_NODE24`
set, repeat dependency installation, preflight, and migrations, then:

```bash
pm2 restart fresh-me-api
curl --fail https://api.yourdomain.com/healthz
```

Expect a brief interruption for this single-process API. Do not restart all
PM2 applications. Environment values are read again from `.env` on
restart. Reseeding does not reset an existing admin password.

Monitor the API health endpoint, host memory/disk, PM2 logs and Razorpay webhook
failures. Arrange log rotation for Fresh Me using your established server log
policy; avoid installing a PM2-wide module without checking its impact on the
other apps. Confirm Supabase backups and recovery. No deployment file can
guarantee uptime on a host whose resource capacity has not been checked.

When the frontend goes on the other EC2 at `/freshme/`, set `CLIENT_ORIGIN` to
its exact HTTPS origin without `/freshme` and restart only `fresh-me-api`.
The current frontend still assumes root hosting: its build base, router, API
URLs, image URLs and CSV download links must first be adapted for `/freshme/`.
Add only a `/freshme/api/` frontend proxy to this backend's `/api/`, preserving
Origin and rewriting the admin cookie path to `/freshme/api/admin`. Do not
replace the frontend host's shared `/api/` routes for the existing projects.
Review trusted client-IP forwarding across both EC2 proxies so rate limits do
not group all customers under the frontend server's address. These are later
frontend/integration tasks; this guide configures the initial direct backend
with one trusted Nginx hop. Razorpay webhooks continue to call the backend
directly. Keep the shop printer agent's SERVER_URL on the backend HTTPS origin.

## References

- [PM2 ecosystem configuration](https://pm2.keymetrics.io/docs/usage/application-declaration/)
- [PM2 startup and saved process lists](https://pm2.keymetrics.io/docs/usage/startup/)
- [nvm installation and PROFILE=/dev/null](https://github.com/nvm-sh/nvm#install--update-script)
- [Nginx proxy_pass](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass)
- [Certbot Nginx installation](https://certbot.eff.org/instructions?ws=nginx&os=snap)
- [Supabase connection methods](https://supabase.com/docs/guides/database/connecting-to-postgres)
