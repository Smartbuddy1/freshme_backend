-- One public shop identifier, with retained aliases for printed QRs and agents.
-- Internal foreign keys stay stable so orders and printer queues never move.
CREATE TABLE fresh_me.shop_identifiers (
  identifier text PRIMARY KEY,
  "shopId" text NOT NULL REFERENCES fresh_me.shops(_id) ON DELETE CASCADE
);
INSERT INTO fresh_me.shop_identifiers(identifier,"shopId")
SELECT slug,_id FROM fresh_me.shops UNION SELECT _id,_id FROM fresh_me.shops;
CREATE INDEX shop_identifiers_shop ON fresh_me.shop_identifiers("shopId");
CREATE FUNCTION fresh_me.reserve_shop_identifiers() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER reserve_shop_identifiers AFTER INSERT OR UPDATE OF slug ON fresh_me.shops
FOR EACH ROW EXECUTE FUNCTION fresh_me.reserve_shop_identifiers();
REVOKE ALL ON fresh_me.shop_identifiers FROM PUBLIC;
