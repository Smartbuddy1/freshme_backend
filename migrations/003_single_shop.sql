-- Preserve immutable migration history while returning runtime data to one shop.
-- Never silently combine independent shops' orders or duplicate their tokens.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM fresh_me.orders WHERE "machineId" <> 'default')
     OR EXISTS (SELECT 1 FROM fresh_me.products WHERE "machineId" <> 'default')
     OR EXISTS (SELECT 1 FROM fresh_me.print_jobs WHERE "machineId" <> 'default') THEN
    RAISE EXCEPTION 'Single-shop upgrade requires reviewed consolidation of non-default business data; no data was changed';
  END IF;
END $$;

ALTER TABLE fresh_me.settings ADD COLUMN "agentKeyHash" text;
ALTER TABLE fresh_me.settings ADD COLUMN "keyVersion" integer NOT NULL DEFAULT 0;
UPDATE fresh_me.settings s SET "agentKeyHash"=m."agentKeyHash","keyVersion"=m."keyVersion"
  FROM fresh_me.machines m WHERE s._id='shop' AND m._id='default';

-- Removing roles must not promote former restricted staff to unrestricted admins.
UPDATE fresh_me.admins SET disabled=true WHERE role='MANAGER';
UPDATE fresh_me.admins SET "sessionVersion"="sessionVersion"+1;
ALTER TABLE fresh_me.admins DROP COLUMN role, DROP COLUMN "machineIds";

DELETE FROM fresh_me.agent_pairings WHERE "machineId" <> 'default';
DELETE FROM fresh_me.agent_events WHERE "machineId" <> 'default';
DELETE FROM fresh_me.agent_commands WHERE "machineId" <> 'default';
ALTER TABLE fresh_me.agent_pairings DROP COLUMN "machineId";
ALTER TABLE fresh_me.agent_events DROP COLUMN "machineId";
ALTER TABLE fresh_me.agent_commands DROP COLUMN "machineId";
CREATE INDEX agent_events_recent ON fresh_me.agent_events (_id DESC);

ALTER TABLE fresh_me.products DROP COLUMN "machineId";
ALTER TABLE fresh_me.print_jobs DROP COLUMN "machineId";
ALTER TABLE fresh_me.orders DROP CONSTRAINT orders_machine_token_unique;
ALTER TABLE fresh_me.orders DROP COLUMN "machineId";
ALTER TABLE fresh_me.orders ADD CONSTRAINT "orders_tokenDate_tokenNo_key" UNIQUE ("tokenDate","tokenNo");
DELETE FROM fresh_me.settings WHERE _id <> 'shop';
DROP TABLE fresh_me.machines;
