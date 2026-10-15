CREATE TABLE fresh_me.machines (
  _id text PRIMARY KEY, code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{2,39}$'),
  name text NOT NULL, enabled boolean NOT NULL DEFAULT true, "isQa" boolean NOT NULL DEFAULT false,
  "agentKeyHash" text, "keyVersion" integer NOT NULL DEFAULT 0,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fresh_me.machines (_id,code,name) SELECT 'default','DEFAULT',"shopName" FROM fresh_me.settings WHERE _id='shop';
ALTER TABLE fresh_me.products ADD COLUMN "machineId" text NOT NULL DEFAULT 'default' REFERENCES fresh_me.machines(_id);
ALTER TABLE fresh_me.orders ADD COLUMN "machineId" text NOT NULL DEFAULT 'default' REFERENCES fresh_me.machines(_id);
ALTER TABLE fresh_me.print_jobs ADD COLUMN "machineId" text NOT NULL DEFAULT 'default' REFERENCES fresh_me.machines(_id);
ALTER TABLE fresh_me.orders DROP CONSTRAINT "orders_tokenDate_tokenNo_key";
ALTER TABLE fresh_me.orders ADD CONSTRAINT orders_machine_token_unique UNIQUE ("machineId","tokenDate","tokenNo");
CREATE INDEX products_machine ON fresh_me.products ("machineId",deleted);
CREATE INDEX orders_machine_date ON fresh_me.orders ("machineId","createdAt");
CREATE INDEX jobs_machine_status ON fresh_me.print_jobs ("machineId",status,"createdAt");
ALTER TABLE fresh_me.admins ADD COLUMN role text NOT NULL DEFAULT 'OWNER' CHECK (role IN ('OWNER','MANAGER'));
ALTER TABLE fresh_me.admins ADD COLUMN "machineIds" jsonb NOT NULL DEFAULT '[]';
ALTER TABLE fresh_me.admins ADD COLUMN disabled boolean NOT NULL DEFAULT false;
ALTER TABLE fresh_me.settings ADD COLUMN "receiptHeader" text NOT NULL DEFAULT '';
ALTER TABLE fresh_me.settings ADD COLUMN "receiptFooter" text NOT NULL DEFAULT 'Thank you!';
ALTER TABLE fresh_me.settings ADD COLUMN "prepCopy" boolean NOT NULL DEFAULT false;
ALTER TABLE fresh_me.settings ADD COLUMN "batchSize" integer NOT NULL DEFAULT 5 CHECK ("batchSize" BETWEEN 1 AND 20);
ALTER TABLE fresh_me.settings ADD COLUMN "agentVersion" text NOT NULL DEFAULT '';
ALTER TABLE fresh_me.settings ADD COLUMN battery integer CHECK (battery BETWEEN 0 AND 100);
ALTER TABLE fresh_me.settings ADD COLUMN "updatedAt" timestamptz NOT NULL DEFAULT now();
CREATE TABLE fresh_me.agent_pairings (
  "codeHash" text PRIMARY KEY, "machineId" text NOT NULL REFERENCES fresh_me.machines(_id),
  "expiresAt" timestamptz NOT NULL, "usedAt" timestamptz
);
CREATE TABLE fresh_me.agent_events (
  _id bigserial PRIMARY KEY, "machineId" text NOT NULL REFERENCES fresh_me.machines(_id),
  level text NOT NULL, message text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_events_machine ON fresh_me.agent_events ("machineId",_id DESC);
CREATE TABLE fresh_me.agent_commands (
  _id text PRIMARY KEY, "machineId" text NOT NULL REFERENCES fresh_me.machines(_id),
  type text NOT NULL CHECK (type IN ('REFRESH_CONFIG','TEST_PRINT')), "createdAt" timestamptz NOT NULL DEFAULT now(),
  "expiresAt" timestamptz NOT NULL DEFAULT now()+interval '5 minutes', "deliveredAt" timestamptz, "acknowledgedAt" timestamptz
);
REVOKE ALL ON ALL TABLES IN SCHEMA fresh_me FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA fresh_me FROM PUBLIC;
