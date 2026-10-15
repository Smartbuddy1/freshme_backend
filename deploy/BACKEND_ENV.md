# Backend environment: PM2, Razorpay, Supabase and private S3

On your existing PM2/Nginx EC2, put the following in `/opt/fresheme_backned/.env`.
Fill placeholders on the server; do not send secrets in chat or commit this file.
Use port 3103 only after confirming it is free. Node 24 is required.

A ready-to-copy version is `.env.pm2.example`. Copy it only if `.env`
does not already exist, then fill in your actual values.

```dotenv
NODE_ENV=production
PORT=3103
TRUST_PROXY=1
LOG_LEVEL=info
DEMO_PAYMENT=false

# Supabase Connect -> Session pooler (port 5432); encode the password component.
DATABASE_URL=postgresql://postgres.PROJECT_REF:ENCODED_PASSWORD@SESSION_POOLER_HOST:5432/postgres
DATABASE_SSL=verify-full
DATABASE_POOL_MAX=10
DATABASE_MIGRATE_ON_START=true
# Optional: absolute path to a custom trusted database CA. Bundled Supabase CA is default.
DATABASE_CA_CERT=

# Generate these separately; minimum 32 characters each.
JWT_SECRET=replace-with-independent-random-secret
AGENT_KEY=replace-with-another-independent-random-secret

# Use real Razorpay test keys first, then live keys for launch.
RAZORPAY_KEY_ID=rzp_test_replace_me
RAZORPAY_KEY_SECRET=replace-with-corresponding-api-secret
RAZORPAY_WEBHOOK_SECRET=replace-with-independent-webhook-secret

# Use your existing S3 bucket's actual name and region.
AWS_REGION=ap-south-1
S3_BUCKET=replace-with-your-bucket-name
S3_KEY_PREFIX=fresh-me/products
# Fill BOTH for dedicated credentials, or leave BOTH empty for an IAM role.
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
# Temporary AWS credentials only; otherwise keep empty.
AWS_SESSION_TOKEN=

ADMIN_EMAIL=owner@your-domain.com
ADMIN_PASSWORD="replace-with-a-strong-unique-value"
# Temporary: real backend HTTPS origin. Later: exact frontend HTTPS origin.
CLIENT_ORIGIN=https://api.your-domain.com
```

The quoted password syntax above is for PM2's dotenv file. Quote values
containing `#` so they are not truncated as comments. Do not `source` this file
in Bash. The separate Docker Compose raw env-file setup expects unquoted values.

## What you obtain versus generate

| Values | Source |
| --- | --- |
| `DATABASE_URL` | Supabase Connect panel; use the exact Session pooler hostname and username for IPv4. |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Razorpay dashboard API keys for the intended Test or Live Mode. |
| `RAZORPAY_WEBHOOK_SECRET` | Generate independently and enter the same secret in Razorpay's webhook configuration. Minimum 16 characters; use 32 random bytes. |
| `JWT_SECRET`, `AGENT_KEY` | Generate separately with the command below. Give only `AGENT_KEY` to the shop printer agent. |
| `AWS_REGION`, `S3_BUCKET` | Your bucket's AWS region and exact name. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Dedicated IAM credentials with the prefix-scoped policy below, unless an existing EC2 role already has permission. Never use root-account access keys. |
| `AWS_SESSION_TOKEN` | Required with temporary access-key credentials; those credentials expire and must be refreshed. EC2 role credentials are refreshed automatically by the SDK. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Your chosen initial owner login. Password: 12+ characters, upper/lowercase, a digit, a symbol, and at least eight distinct characters. Reseeding does not change an existing account password. |
| `CLIENT_ORIGIN` | Exact HTTPS browser origin, with no path. Backend origin temporarily until the frontend is deployed. |

Run once for each independent secret, using Node 24:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

## S3 access and isolation

The bucket can remain private with Block Public Access enabled and ACLs disabled.
Uploads go only into `S3_KEY_PREFIX`, use random UUID filenames, and never set
ACLs, create buckets, delete objects, change policies, or overwrite known files.
Keep the prefix dedicated to Fresh Me and stable after uploading images.

The backend accepts JPG/PNG/WebP files up to 5 MB and 20 megapixels, validates the
image bytes, strips metadata, and resizes to at most 640x640 WebP. Product records
store stable relative `/api/images/<uuid>.webp` URLs. The backend reads those
objects using its credentials; only product images are public through that
route. Arbitrary bucket paths cannot be requested. Browsers never access S3
directly, so no bucket CORS configuration or public read policy is required.

The upload credentials need this IAM policy, replacing the bucket name and
prefix if yours differs. Add it to a dedicated Fresh Me IAM identity, or use
an existing role only if it already has the appropriate access. Do not replace
the EC2 instance role or shared policies used by your two live backends.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:PutObject", "s3:GetObject"],
    "Resource": "arn:aws:s3:::YOUR_BUCKET_NAME/fresh-me/products/*"
  }]
}
```

No bucket-list permission is needed. Existing bucket policies can still deny
these operations. If your bucket uses a customer-managed KMS key, the identity
also needs applicable `kms:GenerateDataKey` and `kms:Decrypt` permissions on
that key, allowed by the key policy. S3 applies the bucket's default encryption;
the app does not change encryption settings.

Changing `S3_BUCKET` or `S3_KEY_PREFIX` later requires migrating existing images
to the corresponding keys. Keep your bucket's backup/versioning policy. The
application intentionally does not delete an image when you remove a product.

## Razorpay and launch checks

Configure automatic capture and the following webhook in the matching mode:

```text
https://YOUR_BACKEND_DOMAIN/api/webhooks/razorpay
```

Subscribe to `payment.captured`, `order.paid`, `payment.failed` and
`refund.processed`. The webhook secret is separate from the Razorpay API secret.
Test and Live Mode require their own credentials and webhook configuration.

After updating the source and installing its dependencies, validate configuration
on EC2 from `/opt/fresh-me` using your selected Node 24 executable:

```bash
"$FRESH_ME_NODE24" --env-file=.env scripts/preflight.js --allow-test-payments
"$FRESH_ME_NODE24" scripts/database.js
```

Preflight validates settings; it does not authenticate to AWS or Razorpay.
Database check is read-only. After initial deployment, restart only Fresh Me
when changing its `.env`: `pm2 restart fresh-me-api`. Follow the PM2 deployment
guide for first migration/seed/startup. Never restart all PM2 processes.

Verify an authenticated image upload and an unauthenticated GET of the returned
image URL. Real S3, Razorpay payments, and physical printing still require
checks against your configured services. For live launch, use live Razorpay
keys and rerun preflight without the test-payments flag.

When you deploy the frontend on the other EC2, update `CLIENT_ORIGIN` and forward
its `/api/` requests (including `/api/images/`) to this backend. No frontend
credentials or bucket URLs are required. Preserve cookies and Origin for admin
login, as described in `EC2_BACKEND_PM2.md`.

References: [AWS credential providers](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html),
[S3 ACL-disabled ownership](https://docs.aws.amazon.com/AmazonS3/latest/userguide/about-object-ownership.html),
[S3 PutObject permissions](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html).
