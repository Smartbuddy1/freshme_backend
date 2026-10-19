# Super Admin and client-shop deployment

This revision adds migrations `004_client_shops.sql` and `005_editable_shop_urls.sql`. Backend, frontend and printer agent remain separate deployments. Do not deploy an old backend with the new frontend or downgrade after migration without restoring the matching database backup.

## Application URLs and roles

- `/admin`: shared login for Super Admin and Client Admin. The authenticated account role chooses the dashboard automatically. Signed-out admin links return here.
- `/super-admin`: platform owner dashboard after login. Manage client shops and their admin credentials, disable access, download each shop's QR, inspect all payments and reports, export CSV, and update platform settings.
- `/admin`: client admin dashboard after login. Access only the assigned shop's products, orders, payments, reports, receipt settings and printer pairing.
- `/admin?shop=SHOP_ID`: Super Admin opens the existing client-admin interface for a selected shop. Server authorization checks the session and selected shop on every request.
- `/fresheme/rahul-juice`: public ordering page for one shop. Its token page is `/fresheme/rahul-juice/order/ORDER_ID`. **`fresheme` is the intended path spelling.** Slugs use lowercase letters, numbers and hyphens, 3–60 characters; they are unique and editable by Super Admin. This URL slug is also the visible Shop ID used by the printer agent. Changing the display name does not change the URL. Editing the Shop ID updates new QR downloads while previously printed links and paired agents continue to work.
- The original shop keeps slug `fresh-me`. `/` and `/order/ID` remain compatible with its existing links. Other shops have isolated browser carts and checkout retries.

The shop URL is public; it grants no admin access. Phone and customer name remain optional. A supplied phone must be a valid Indian ten-digit mobile number.

## Shared Razorpay

Use ONE set of `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` on the backend. Keep one webhook targeting this backend's `/api/webhooks/razorpay`. Do not put private keys in the frontend or client settings.

Every order stores its shop ID before gateway creation. Verification and signed webhooks use this stored attribution. Super Admin payments/reports can filter by shop; each client admin sees only its own totals. Tokens restart daily per shop in IST; `ORD-*` order codes remain globally unique. Reports show gross captured collections and the number of orders flagged refunded. They do not calculate net settlement or automatic client payouts; funds settle to your single Razorpay account.

## Upgrade an existing backend

Before upgrading, run `npm run db:check` and inspect migration history. This release refuses unknown migration filenames. A database with `004_multitenant_auth.sql`, `005_shop_lifecycle.sql` or `006_per_shop_razorpay.sql` belongs to a different implementation and needs a reviewed data conversion. Do not delete migration records or run this release's migrations over that schema to bypass the guard.

1. Back up the `fresh_me` schema (including migration metadata) and record your current release. Use your existing secure backup process; do not put DB credentials in shell history or commit backups.
2. Pause customer ordering during the release and stop only this application's process using its actual process-manager name. Do not restart all PM2 apps or alter the existing services on ports 5001/5080. Keep this backend on its separately reserved port, for example 3103 if free.
3. Pull the reviewed/published revision into the backend checkout. The local coding changes must first be committed and pushed before EC2 can pull them. From the directory containing this backend's `package.json`:

   ```bash
   npm ci
   npm run db:migrate
   npm run superadmin:setup
   ```

   `superadmin:setup` uses `ADMIN_EMAIL` and `ADMIN_PASSWORD` from the backend's existing protected `.env`. Set `ADMIN_EMAIL` to the account you intend to own the platform. For an existing active account, it promotes only that account, preserves its current password, clears its shop assignment and revokes its sessions. For a new account, it uses the configured strong password. It refuses to promote a disabled account. Re-running is safe. Never share the `.env` or its contents.

4. Migration 004 preserves original products, orders, payments, tokens, printer jobs and settings, assigning them to the original shop. Existing active admins become Client Admins for that shop until explicitly promoted. Previously disabled staff remain disabled. Sessions are revoked on migration, so users must log in again. Migrations 001–003 are unchanged; migration 003 intentionally refuses historical non-default machine business data. If that guard triggers, stop and arrange a reviewed data conversion instead of editing applied migrations or silently merging shops.
   Migration 005 retains the internal shop foreign keys and reserves both current IDs and historical URL aliases for their original shops. Previous QR links and agent IDs keep working after a URL edit. Another shop cannot claim these aliases. Run it before starting the updated backend.

5. Deploy the matching frontend with the root route fallback below, then start/restart **only this application's named process**. Verify `/healthz`, sign in at `/admin`, and check the original shop's records. If the promoted owner was its only admin, add a separate Client Admin to that shop through **Clients → Edit shop**.

For a fresh database, `npm run seed` creates the configured account as Super Admin and adds the original sample menu. Existing accounts are never silently promoted by seed. Run seed against production only when you actually want that sample menu; use `superadmin:setup` for upgrading real data.

## Frontend hosting and QR origin

Serve the frontend at the origin root. The default Vite asset base is `/`. Configure SPA fallback for `/super-admin/*`, `/admin/*`, `/fresheme/*` and token deep links. The QR uses the origin where the Super Admin page is open, so generate production QRs from the permanent production frontend URL, not localhost or a preview domain. Domain changes require new printed QRs or an HTTP redirect from the old domain.

For the existing `/freshme/` deployment, use `VITE_BASE_PATH=/freshme/` when building, serve assets and SPA fallback under that prefix, and proxy `/freshme/api/` to backend `/api/`. Shop QRs then use `/freshme/fresheme/SHOP_ID`. Keep `CLIENT_ORIGIN` at the domain origin without `/freshme`. See the frontend README for details.

Prefer a same-origin `/api` proxy. On Vercel, configure `BACKEND_URL` as the actual HTTPS backend base URL (include a prefix only if your reverse proxy uses one); the checked-in rewrites handle browser routes. There is no hard-coded fallback. The proxy forwards the caller's Origin, cookies and `X-Shop-Id`; it never fabricates an allowed Origin. Set backend `CLIENT_ORIGIN` to the frontend's exact HTTPS origin and `COOKIE_PATH=/`. Do not point `BACKEND_URL` at plain remote HTTP. The backend can still listen on its private loopback port behind your existing HTTPS proxy.

For Nginx serving the frontend, add these locations only to the appropriate frontend virtual host using your existing TLS setup:

```nginx
# root /path/to/frontend/dist;
location /api/ {
    proxy_pass http://127.0.0.1:3103;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    client_max_body_size 6m;
    proxy_read_timeout 60s;
}
location / {
    try_files $uri $uri/ /index.html;
}
```

This example assumes the API runs on the same host and this Nginx is its trusted proxy; use your actual topology. Do not replace other applications' Nginx server blocks. An IP-based frontend can use the same paths; production cookies, payments and remote printer pairing still require correctly configured HTTPS.

## Onboard each client

1. In **Super Admin → Clients → Add client**, set shop name, editable Shop ID / URL, admin email and a strong initial password. New shops start with orders paused.
2. Open that shop's admin. Add its products/prices and receipt details. The client can sign in at `/admin` with the assigned credentials and change their password.
3. Use **Copy ID** beside the ordering URL on the client card or Client Admin dashboard. For `/fresheme/rahul-juice`, the ID is `rahul-juice`. In that shop's **Shop Settings → Printer agent**, generate its one-time pairing code. On that shop's Windows PC, run `npm run pair` from the separate agent folder. Enter the backend HTTPS URL, Shop ID and that shop's code. The agent saves `SERVER_URL`, `SHOP_ID` and its scoped `AGENT_KEY` locally; Windows installed USB/LAN printers work with `PRINTER_NAME=auto`. The server rejects a key/ID mismatch before claiming jobs or updating a heartbeat. Start the agent and send a test print. See [the complete shop-printer setup](../../agent/SHOP_CONNECTION.md).
4. Pairing rotates only that shop's key. Do not copy one shop's agent `.env` to another shop. The old environment `AGENT_KEY` is a compatibility key for the original shop only until it is paired; it is not a global key for all shops. One active paired agent per shop is the supported configuration.
5. Confirm a receipt on the physical printer, then accept orders. Download **Clients → QR code → Download QR PNG** and place it at that shop's counter.
6. Check that the correct shop gets the order, daily token and printer job. The user reports that live payment was already tested; this release retains the shared Razorpay flow and adds shop attribution and access controls. Client cards, Client Admin dashboard and printer settings show separate Agent/Printer status. Lists/settings poll every ten seconds; heartbeats older than thirty seconds appear offline.

Pausing orders blocks new checkout but allows client administration and already-started payment completion. Disabling a shop also revokes client sessions and blocks new client logins, menus and printer authentication. It preserves history and allows already-paid/pending order reconciliation; queued receipts resume when the shop and its agent are re-enabled. A paid order must never lose its payment attribution simply because a shop is disabled.

## Validation limits

Disposable PostgreSQL tests cover tenant authorization, public checkout isolation, shared gateway attribution, per-shop tokens, signed webhook retries, print-job FK isolation, scoped agent pairing/leases/commands, disabled shops, and explicit owner promotion. Offline browser tests cover client creation, QR URL/download, super-to-client navigation, payments/report filtering, settings and per-shop cart storage at mobile/desktop sizes. Local tests do not certify your deployed HTTPS, actual DB backup, Razorpay live setup or physical printer output. See the repository `qa/REPORT.md` for current evidence.
