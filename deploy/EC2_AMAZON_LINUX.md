# Fresh Me backend on Amazon Linux 2023

This guide assumes an `ec2-user` login, an existing Nginx installation loading
`/etc/nginx/conf.d/*.conf`, and a separate Fresh Me directory at
`/home/ec2-user/fresheme_backned`. Check available memory/disk and confirm
port 3103 is unused before proceeding.

Keep other applications, their Node runtimes, PM2 installation and Nginx sites
intact. The instructions use `freshme-api.example.com` as a placeholder:
substitute your chosen unused hostname everywhere.
No DNS record, certificate, or EC2 change has been created by this repository.

## 1. Upload the backend folder

Copy the local `fresheme_backned/` folder to `/home/ec2-user/fresheme_backned/`
using SFTP or SCP. The destination must directly contain `package.json`,
`package-lock.json`, `src/`, `scripts/`, `migrations/`, `certs/` and `deploy/`.
Frontend and agent folders are not required. Exclude Windows `node_modules`
and local development env files; create the EC2 `.env` in step 3.

```bash
cd /home/ec2-user/fresheme_backned
ls -la
```

## 2. Install a separate Node 24 runtime

This is per-user and runs in a subshell; it does not replace system Node, change
the current shell's PATH, or modify a login profile. It needs curl and normal
Linux archive tools. Existing packages and live processes are not restarted.

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
"$FRESH_ME_NODE24" --version
/usr/bin/node --version
```

Expect v24 for Fresh Me and the existing v20 for system Node. Keep the dedicated
runtime installed. Re-export FRESH_ME_NODE24 as above in any new SSH session.

## 3. Install dependencies and configure the environment

```bash
cd /home/ec2-user/fresheme_backned
PATH="$(dirname "$FRESH_ME_NODE24"):$PATH" npm ci --omit=dev
test -f .env || cp .env.pm2.example .env
chmod 600 .env
nano .env
```

Fill every setting using `BACKEND_ENV.md`. In particular:

- PORT=3103 (recheck it is unused before startup).
- Supabase Session pooler URL, verified TLS and Fresh Me's own database.
- Independent JWT, agent and Razorpay webhook secrets.
- Real Razorpay Test Mode credentials initially; no production demo mode.
- AWS region, private S3 bucket and `fresh-me/products` prefix. Use dedicated
  credentials with GetObject/PutObject permissions on that prefix, or an already
  permitted role. Do not replace the shared EC2 role or bucket policy.
- Strong owner email/password.
- CLIENT_ORIGIN is the future frontend HTTPS origin without `/freshme`. Until
  that is known, use the chosen backend HTTPS origin temporarily.

Quote `.env` values containing `#`. Do not source the file in Bash. Do not upload
or paste secret values into chat. Create the EC2 env file from the supplied template.

## 4. Validate and initialize Fresh Me only

Run separately, stopping at any error:

```bash
"$FRESH_ME_NODE24" --env-file=.env scripts/preflight.js --allow-test-payments
"$FRESH_ME_NODE24" scripts/database.js
"$FRESH_ME_NODE24" scripts/database.js --migrate
"$FRESH_ME_NODE24" src/seed.js
```

Preflight checks configuration, not live AWS/Razorpay permissions. Migrations
and seed write to the configured database, so check that its URL is Fresh Me's.

## 5. Start the new PM2 process

```bash
sudo ss -ltnp
pm2 list
```

Confirm 3103 and the name fresh-me-api remain unused, then:

```bash
pm2 start deploy/ecosystem.config.cjs --only fresh-me-api
pm2 logs fresh-me-api --lines 50 --nostream
curl --fail http://127.0.0.1:3103/healthz
curl --fail http://127.0.0.1:3103/api/menu
pm2 list
sudo ss -ltnp
```

Expect Fresh Me online, health `{"ok":true}` and menu data. Verify other
applications remain healthy using their existing health checks.

Do not run `pm2 save`, `pm2 startup`, `pm2 resurrect`, `pm2 update`, or any command
targeting all applications yet. Inspect the existing boot setup and saved PM2
process list before changing persistence, especially if other applications
have separate service managers or existing failures. These read-only commands
identify the startup mechanisms without printing application secrets:

```bash
systemctl list-unit-files 'pm2-*'
systemctl --user list-unit-files 'pm2-*'
```

This staging process alone is not a complete reboot-persistence setup. After
the saved startup state is understood, back it up and add Fresh Me to the
appropriate startup mechanism without replacing existing service definitions.

## 6. Add a NEW hostname and Nginx file

Create a DNS A record for your chosen NEW hostname pointing to this EC2's public
IP (not its private 10.x address). Verify the hostname is not used by any other
application. Keep existing applications' hostnames and DNS records intact.

Back up the shared Nginx config, then create a new file only if unused:

```bash
sudo cp -a /etc/nginx "/root/nginx-before-freshme-$(date +%Y%m%d-%H%M%S)"
sudo test ! -e /etc/nginx/conf.d/fresh-me-api.conf && sudo cp deploy/nginx-backend.conf.example /etc/nginx/conf.d/fresh-me-api.conf
```

If the destination already exists, stop and inspect it before editing. Otherwise:

```bash
sudo nano /etc/nginx/conf.d/fresh-me-api.conf
```

Change only this new file's server_name to your chosen hostname, for example:

```nginx
server_name freshme-api.example.com;
```

Keep the upstream `http://127.0.0.1:3103` if using port 3103. Do not create
sites-available/sites-enabled directories on this host. Test first:

```bash
sudo nginx -t
```

Only if it passes, gracefully reload:

```bash
sudo systemctl reload nginx
```

If this host already uses Certbot-managed HTTPS and the installed Certbot Nginx
plugin is available, issue a certificate for ONLY the new hostname after DNS
resolves correctly:

```bash
sudo certbot --nginx -d freshme-api.example.com
sudo nginx -t
```

Use your chosen domain instead if different. Do not reinstall certificate
tooling or expand/change another application's certificate as part of this setup.
Keep TCP 80/443 available and do not expose 3103 publicly. The app currently
listens on host interfaces; retain security-group/firewall restrictions.

## 7. Public verification and later integration

```bash
curl --fail https://freshme-api.example.com/healthz
curl --fail https://freshme-api.example.com/api/menu
```

Check other applications' known working URLs too. Backend `/` and `/admin` may return
Client build missing; the frontend is deliberately absent.

Razorpay webhook, in the matching Test/Live Mode:

```text
https://freshme-api.example.com/api/webhooks/razorpay
```

Use the matching secret, automatic capture and events payment.captured,
order.paid, payment.failed, refund.processed. Before launch, switch to live
credentials and run preflight without --allow-test-payments.

Real S3 upload/download, checkout/webhook/receipt verification, log rotation,
monitoring, database backups and reboot persistence remain launch checks.
Changes to Fresh Me's `.env` require only `pm2 restart fresh-me-api`.

For the later frontend on another EC2 at `/freshme`, use its origin without the
path in CLIENT_ORIGIN. The frontend needs base-path updates and a dedicated
`/freshme/api/` proxy, admin cookie-path rewriting and reviewed client-IP trust
across the two proxies. Do not replace any other project's `/api` routes.

Reference: [nvm installation](https://github.com/nvm-sh/nvm#install--update-script).
