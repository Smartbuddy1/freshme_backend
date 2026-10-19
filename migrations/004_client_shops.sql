-- Client shops replace the former single-shop runtime. Existing records remain
-- attached to the original shop; no order, token or payment is moved/deleted.
CREATE TABLE fresh_me.shops (
  _id text PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) BETWEEN 3 AND 60),
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fresh_me.shops(_id,slug,name) SELECT 'shop','fresh-me',"shopName" FROM fresh_me.settings WHERE _id='shop';
ALTER TABLE fresh_me.settings ADD FOREIGN KEY (_id) REFERENCES fresh_me.shops(_id);
CREATE UNIQUE INDEX shop_agent_key_unique ON fresh_me.settings("agentKeyHash") WHERE "agentKeyHash" IS NOT NULL;

ALTER TABLE fresh_me.products ADD COLUMN "shopId" text NOT NULL DEFAULT 'shop' REFERENCES fresh_me.shops(_id);
ALTER TABLE fresh_me.orders ADD COLUMN "shopId" text NOT NULL DEFAULT 'shop' REFERENCES fresh_me.shops(_id);
ALTER TABLE fresh_me.print_jobs ADD COLUMN "shopId" text NOT NULL DEFAULT 'shop' REFERENCES fresh_me.shops(_id);
ALTER TABLE fresh_me.orders DROP CONSTRAINT "orders_tokenDate_tokenNo_key";
ALTER TABLE fresh_me.orders ADD CONSTRAINT orders_shop_token_unique UNIQUE("shopId","tokenDate","tokenNo");
ALTER TABLE fresh_me.orders ADD CONSTRAINT orders_id_shop_unique UNIQUE(_id,"shopId");
ALTER TABLE fresh_me.print_jobs ADD CONSTRAINT jobs_order_shop_fk FOREIGN KEY("orderId","shopId") REFERENCES fresh_me.orders(_id,"shopId");
CREATE INDEX products_shop ON fresh_me.products("shopId",deleted);
CREATE INDEX orders_shop_created ON fresh_me.orders("shopId","createdAt");
CREATE INDEX orders_shop_paid ON fresh_me.orders("shopId","paidAt");
CREATE INDEX print_jobs_shop_status ON fresh_me.print_jobs("shopId",status,"createdAt");

ALTER TABLE fresh_me.admins ADD COLUMN role text NOT NULL DEFAULT 'CLIENT_ADMIN' CHECK(role IN ('SUPER_ADMIN','CLIENT_ADMIN'));
ALTER TABLE fresh_me.admins ADD COLUMN "shopId" text DEFAULT 'shop' REFERENCES fresh_me.shops(_id);
ALTER TABLE fresh_me.admins ADD CONSTRAINT admins_role_scope CHECK((role='SUPER_ADMIN' AND "shopId" IS NULL) OR (role='CLIENT_ADMIN' AND "shopId" IS NOT NULL));
UPDATE fresh_me.admins SET "sessionVersion"="sessionVersion"+1;
CREATE INDEX admins_shop ON fresh_me.admins("shopId");

ALTER TABLE fresh_me.agent_pairings ADD COLUMN "shopId" text NOT NULL DEFAULT 'shop' REFERENCES fresh_me.shops(_id);
ALTER TABLE fresh_me.agent_events ADD COLUMN "shopId" text NOT NULL DEFAULT 'shop' REFERENCES fresh_me.shops(_id);
ALTER TABLE fresh_me.agent_commands ADD COLUMN "shopId" text NOT NULL DEFAULT 'shop' REFERENCES fresh_me.shops(_id);
CREATE INDEX agent_events_shop_recent ON fresh_me.agent_events("shopId",_id DESC);
CREATE INDEX agent_commands_shop_pending ON fresh_me.agent_commands("shopId","expiresAt") WHERE "deliveredAt" IS NULL;

CREATE TABLE fresh_me.platform_settings (
  _id text PRIMARY KEY DEFAULT 'platform' CHECK(_id='platform'),
  name text NOT NULL DEFAULT 'Fresh Me',
  "supportEmail" text NOT NULL DEFAULT '',
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fresh_me.platform_settings(_id) VALUES ('platform');
REVOKE ALL ON ALL TABLES IN SCHEMA fresh_me FROM PUBLIC;
