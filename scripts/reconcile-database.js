import { readDatabaseConfig } from '../src/config.js';
import { connectDatabase, disconnectDatabase, transaction } from '../src/database.js';
import { verifyMigrations } from '../src/migrate.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

async function reconcile() {
  const config = readDatabaseConfig();
  await connectDatabase(config);
  console.log('Connected to database. Starting reconciliation...');

  await transaction(async client => {
    // 1. Create fresh_me.shops if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS fresh_me.shops (
        _id text PRIMARY KEY,
        slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) BETWEEN 3 AND 60),
        name text NOT NULL,
        enabled boolean NOT NULL DEFAULT true,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);

    // Insert default shop from settings if available
    await client.query(`
      INSERT INTO fresh_me.shops (_id, slug, name, enabled)
      SELECT 'shop', 'fresh-me', COALESCE("shopName", 'Fresh Me'), true 
      FROM fresh_me.settings WHERE _id='shop'
      ON CONFLICT (_id) DO UPDATE SET slug='fresh-me', enabled=true
    `);

    // Ensure shop FK on settings
    const { rows: settingsFk } = await client.query(`
      SELECT constraint_name FROM information_schema.table_constraints 
      WHERE table_schema='fresh_me' AND table_name='settings' AND constraint_type='FOREIGN KEY'
    `);
    if (!settingsFk.some(r => r.constraint_name.includes('shop'))) {
      await client.query(`
        ALTER TABLE fresh_me.settings 
        ADD CONSTRAINT settings_shop_fk FOREIGN KEY (_id) REFERENCES fresh_me.shops(_id)
      `);
    }

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS shop_agent_key_unique 
      ON fresh_me.settings("agentKeyHash") WHERE "agentKeyHash" IS NOT NULL
    `);

    // 2. Add shopId to products
    const { rows: prodCols } = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_schema='fresh_me' AND table_name='products'
    `);
    if (!prodCols.some(c => c.column_name === 'shopId')) {
      await client.query(`ALTER TABLE fresh_me.products ADD COLUMN "shopId" text NOT NULL DEFAULT 'shop' REFERENCES fresh_me.shops(_id)`);
    }
    await client.query(`CREATE INDEX IF NOT EXISTS products_shop ON fresh_me.products("shopId", deleted)`);

    // 3. Add shopId to orders
    const { rows: orderCols } = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_schema='fresh_me' AND table_name='orders'
    `);
    if (!orderCols.some(c => c.column_name === 'shopId')) {
      await client.query(`ALTER TABLE fresh_me.orders ADD COLUMN "shopId" text NOT NULL DEFAULT 'shop' REFERENCES fresh_me.shops(_id)`);
    }

    // Constraints on orders
    await client.query(`ALTER TABLE fresh_me.orders DROP CONSTRAINT IF EXISTS "orders_tokenDate_tokenNo_key"`);
    await client.query(`ALTER TABLE fresh_me.orders DROP CONSTRAINT IF EXISTS orders_shop_token_unique`);
    await client.query(`ALTER TABLE fresh_me.orders ADD CONSTRAINT orders_shop_token_unique UNIQUE("shopId","tokenDate","tokenNo")`);
    await client.query(`ALTER TABLE fresh_me.orders DROP CONSTRAINT IF EXISTS orders_id_shop_unique`);
    await client.query(`ALTER TABLE fresh_me.orders ADD CONSTRAINT orders_id_shop_unique UNIQUE(_id,"shopId")`);
    await client.query(`CREATE INDEX IF NOT EXISTS orders_shop_created ON fresh_me.orders("shopId","createdAt")`);
    await client.query(`CREATE INDEX IF NOT EXISTS orders_shop_paid ON fresh_me.orders("shopId","paidAt")`);

    // 4. Add shopId to print_jobs
    const { rows: jobCols } = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_schema='fresh_me' AND table_name='print_jobs'
    `);
    if (!jobCols.some(c => c.column_name === 'shopId')) {
      await client.query(`ALTER TABLE fresh_me.print_jobs ADD COLUMN "shopId" text NOT NULL DEFAULT 'shop' REFERENCES fresh_me.shops(_id)`);
    }
    await client.query(`ALTER TABLE fresh_me.print_jobs DROP CONSTRAINT IF EXISTS jobs_order_shop_fk`);
    await client.query(`ALTER TABLE fresh_me.print_jobs ADD CONSTRAINT jobs_order_shop_fk FOREIGN KEY("orderId","shopId") REFERENCES fresh_me.orders(_id,"shopId")`);
    await client.query(`CREATE INDEX IF NOT EXISTS print_jobs_shop_status ON fresh_me.print_jobs("shopId",status,"createdAt")`);

    // 5. Admins
    const { rows: adminCols } = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_schema='fresh_me' AND table_name='admins'
    `);
    if (!adminCols.some(c => c.column_name === 'role')) {
      await client.query(`ALTER TABLE fresh_me.admins ADD COLUMN role text NOT NULL DEFAULT 'CLIENT_ADMIN' CHECK(role IN ('SUPER_ADMIN','CLIENT_ADMIN'))`);
    }
    if (!adminCols.some(c => c.column_name === 'shopId')) {
      await client.query(`ALTER TABLE fresh_me.admins ADD COLUMN "shopId" text DEFAULT 'shop' REFERENCES fresh_me.shops(_id)`);
    }
    await client.query(`ALTER TABLE fresh_me.admins DROP CONSTRAINT IF EXISTS admins_role_scope`);
    await client.query(`
      UPDATE fresh_me.admins SET role='SUPER_ADMIN', "shopId"=NULL WHERE email ILIKE '%superadmin%'
    `);
    await client.query(`
      UPDATE fresh_me.admins SET role='CLIENT_ADMIN', "shopId"='shop' WHERE role IS NULL OR role <> 'SUPER_ADMIN'
    `);
    await client.query(`ALTER TABLE fresh_me.admins ADD CONSTRAINT admins_role_scope CHECK((role='SUPER_ADMIN' AND "shopId" IS NULL) OR (role='CLIENT_ADMIN' AND "shopId" IS NOT NULL))`);
    await client.query(`UPDATE fresh_me.admins SET "sessionVersion"="sessionVersion"+1`);
    await client.query(`CREATE INDEX IF NOT EXISTS admins_shop ON fresh_me.admins("shopId")`);

    // 6. Agent pairings / events / commands
    for (const tbl of ['agent_pairings', 'agent_events', 'agent_commands']) {
      const { rows: cols } = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='fresh_me' AND table_name=$1`, [tbl]);
      if (!cols.some(c => c.column_name === 'shopId')) {
        await client.query(`ALTER TABLE fresh_me.${tbl} ADD COLUMN "shopId" text NOT NULL DEFAULT 'shop' REFERENCES fresh_me.shops(_id)`);
      }
    }
    await client.query(`CREATE INDEX IF NOT EXISTS agent_events_shop_recent ON fresh_me.agent_events("shopId",_id DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS agent_commands_shop_pending ON fresh_me.agent_commands("shopId","expiresAt") WHERE "deliveredAt" IS NULL`);

    // 7. Platform settings
    await client.query(`
      CREATE TABLE IF NOT EXISTS fresh_me.platform_settings (
        _id text PRIMARY KEY DEFAULT 'platform' CHECK(_id='platform'),
        name text NOT NULL DEFAULT 'Fresh Me',
        "supportEmail" text NOT NULL DEFAULT '',
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    const { rows: psCols } = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='fresh_me' AND table_name='platform_settings'`);
    if (!psCols.some(c => c.column_name === 'name')) {
      await client.query(`ALTER TABLE fresh_me.platform_settings ADD COLUMN name text NOT NULL DEFAULT 'Fresh Me'`);
    }
    if (!psCols.some(c => c.column_name === 'supportEmail')) {
      await client.query(`ALTER TABLE fresh_me.platform_settings ADD COLUMN "supportEmail" text NOT NULL DEFAULT ''`);
    }
    await client.query(`INSERT INTO fresh_me.platform_settings(_id) VALUES ('platform') ON CONFLICT (_id) DO NOTHING`);

    // 8. Shop identifiers
    await client.query(`
      CREATE TABLE IF NOT EXISTS fresh_me.shop_identifiers (
        identifier text PRIMARY KEY,
        "shopId" text NOT NULL REFERENCES fresh_me.shops(_id) ON DELETE CASCADE
      )
    `);
    await client.query(`
      INSERT INTO fresh_me.shop_identifiers(identifier,"shopId")
      SELECT slug,_id FROM fresh_me.shops UNION SELECT _id,_id FROM fresh_me.shops
      ON CONFLICT (identifier) DO NOTHING
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS shop_identifiers_shop ON fresh_me.shop_identifiers("shopId")`);

    await client.query(`
      CREATE OR REPLACE FUNCTION fresh_me.reserve_shop_identifiers() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE value text;
      BEGIN
        FOREACH value IN ARRAY ARRAY[NEW._id,NEW.slug] LOOP
          INSERT INTO fresh_me.shop_identifiers(identifier,"shopId") VALUES(value,NEW._id)
          ON CONFLICT(identifier) DO UPDATE SET "shopId"=EXCLUDED."shopId"
            WHERE fresh_me.shop_identifiers."shopId"=EXCLUDED."shopId";
          IF NOT FOUND THEN
            RAISE EXCEPTION 'Shop identifier already belongs to another shop' USING ERRCODE='23505';
          END IF;
        END LOOP;
        RETURN NEW;
      END $$;
    `);
    await client.query(`DROP TRIGGER IF EXISTS reserve_shop_identifiers ON fresh_me.shops`);
    await client.query(`
      CREATE TRIGGER reserve_shop_identifiers AFTER INSERT OR UPDATE OF slug ON fresh_me.shops
      FOR EACH ROW EXECUTE FUNCTION fresh_me.reserve_shop_identifiers()
    `);

    // 9. Reconcile schema_migrations
    // Delete legacy migration records that don't belong to this release
    await client.query(`
      DELETE FROM fresh_me.schema_migrations 
      WHERE name IN ('004_multitenant_auth.sql', '005_shop_lifecycle.sql', '006_per_shop_razorpay.sql')
    `);

    // Read exact sql files for 004 and 005 to record accurate checksums
    const dir = new URL('../migrations/', import.meta.url);
    for (const name of ['004_client_shops.sql', '005_editable_shop_urls.sql']) {
      const sql = await readFile(new URL(name, dir), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      await client.query(`
        INSERT INTO fresh_me.schema_migrations (name, checksum, applied_at)
        VALUES ($1, $2, now())
        ON CONFLICT (name) DO UPDATE SET checksum=$2
      `, [name, checksum]);
    }

    await client.query('REVOKE ALL ON ALL TABLES IN SCHEMA fresh_me FROM PUBLIC');
    console.log('Schema changes applied successfully.');
  });

  // Verify
  await verifyMigrations();
  console.log('verifyMigrations() PASSED successfully!');
  await disconnectDatabase();
}

reconcile().catch(e => {
  console.error('Reconciliation failed:', e);
  process.exit(1);
});
