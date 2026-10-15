-- Private schema: not exposed through Supabase's public REST API.
CREATE SCHEMA IF NOT EXISTS fresh_me;
REVOKE ALL ON SCHEMA fresh_me FROM PUBLIC;
CREATE TABLE fresh_me.products (
  _id text PRIMARY KEY, name text NOT NULL, category text, "flavorColor" text,
  "imageUrl" text NOT NULL DEFAULT '', sizes jsonb NOT NULL DEFAULT '[]',
  available boolean NOT NULL DEFAULT true, "sortOrder" integer NOT NULL DEFAULT 0,
  deleted boolean NOT NULL DEFAULT false,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE fresh_me.orders (
  _id text PRIMARY KEY, "tokenNo" integer, "tokenDate" text, "orderCode" text UNIQUE,
  items jsonb NOT NULL DEFAULT '[]', total integer NOT NULL CHECK (total > 0),
  "customerName" text NOT NULL DEFAULT '', phone text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'PENDING_PAYMENT' CHECK (status IN ('PENDING_PAYMENT','PAID','SERVED','EXPIRED')),
  "idempotencyKey" text NOT NULL UNIQUE, "requestHash" text,
  "razorpayOrderId" text UNIQUE, "razorpayPaymentId" text UNIQUE, "paymentMethod" text,
  "paidAt" timestamptz, "servedAt" timestamptz, refunded boolean NOT NULL DEFAULT false,
  "razorpayCreateStartedAt" timestamptz, "creationError" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("tokenDate", "tokenNo")
);
CREATE INDEX orders_status_created ON fresh_me.orders (status, "createdAt");
CREATE INDEX orders_paid ON fresh_me.orders ("paidAt");
CREATE TABLE fresh_me.print_jobs (
  _id text PRIMARY KEY, type text NOT NULL CHECK (type IN ('ORDER','REPRINT','TEST')),
  "orderId" text REFERENCES fresh_me.orders(_id),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PRINTING','PRINTED','FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  "claimedAt" timestamptz, "printedAt" timestamptz, "lastError" text, "claimId" text,
  payload jsonb NOT NULL DEFAULT '{}',
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX print_jobs_original ON fresh_me.print_jobs ("orderId") WHERE type = 'ORDER';
CREATE INDEX print_jobs_status_created ON fresh_me.print_jobs (status, "createdAt", _id);
CREATE TABLE fresh_me.admins (
  _id text PRIMARY KEY, email text NOT NULL UNIQUE, "passwordHash" text NOT NULL,
  "sessionVersion" integer NOT NULL DEFAULT 0
);
CREATE TABLE fresh_me.settings (
  _id text PRIMARY KEY DEFAULT 'shop', "shopName" text NOT NULL DEFAULT 'Fresh Me',
  tagline text NOT NULL DEFAULT 'Sip and chill.', "acceptingOrders" boolean NOT NULL DEFAULT true,
  "agentLastSeenAt" timestamptz, "agentPrinterStatus" text NOT NULL DEFAULT 'unknown'
    CHECK ("agentPrinterStatus" IN ('online','offline','unknown'))
);
CREATE TABLE fresh_me.counters (_id text PRIMARY KEY, seq integer NOT NULL DEFAULT 0);
CREATE TABLE fresh_me.refunds (
  _id text PRIMARY KEY, "paymentId" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refunds_payment ON fresh_me.refunds ("paymentId");
REVOKE ALL ON ALL TABLES IN SCHEMA fresh_me FROM PUBLIC;
INSERT INTO fresh_me.settings (_id) VALUES ('shop') ON CONFLICT DO NOTHING;
