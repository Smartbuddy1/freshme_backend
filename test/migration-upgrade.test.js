import {it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {testDatabase} from './database-helper.js';
import {database} from '../src/database.js';
import {migrate,verifyMigrations} from '../src/migrate.js';
it('upgrades existing single-shop data without losing orders, tokens, products, users or jobs',async()=>{
  const db=await testDatabase({beforeMigrate:async client=>{
    const sql=await readFile(new URL('../migrations/001_initial.sql',import.meta.url),'utf8');
    await client.query('CREATE SCHEMA fresh_me');
    await client.query('CREATE TABLE fresh_me.schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz DEFAULT now())');
    await client.query(sql);
    await client.query('INSERT INTO fresh_me.schema_migrations(name,checksum) VALUES ($1,$2)',['001_initial.sql',createHash('sha256').update(sql).digest('hex')]);
    await client.query("INSERT INTO fresh_me.products(_id,name,category,\"flavorColor\",sizes) VALUES ('old-product','QA Test Slush','QA-TEST','#aa2277','[]')");
    await client.query("INSERT INTO fresh_me.orders(_id,total,\"idempotencyKey\",status,\"tokenDate\",\"tokenNo\") VALUES ('old-order',1,'old-key','PAID','2026-10-15',9)");
    await client.query("INSERT INTO fresh_me.print_jobs(_id,type,\"orderId\",payload) VALUES ('old-job','ORDER','old-order','{}')");
    await client.query("INSERT INTO fresh_me.admins(_id,email,\"passwordHash\") VALUES ('old-owner','owner@qa.invalid','fixture-not-a-password')");
    await client.query("INSERT INTO fresh_me.counters(_id,seq) VALUES ('2026-10-15',9)");
  }});
  try{
    for(const [table,id] of [['products','old-product'],['orders','old-order'],['print_jobs','old-job']])expect((await database().query('SELECT _id FROM fresh_me.'+table+' WHERE _id=$1',[id])).rows[0]._id).toBe(id);
    expect((await database().query("SELECT \"tokenNo\",status FROM fresh_me.orders WHERE _id='old-order'")).rows[0]).toMatchObject({tokenNo:9,status:'PAID'});
    expect((await database().query("SELECT disabled FROM fresh_me.admins WHERE _id='old-owner'")).rows[0]).toEqual({disabled:false});
    expect((await database().query("SELECT seq FROM fresh_me.counters WHERE _id='2026-10-15'")).rows[0].seq).toBe(9);
    await migrate();await verifyMigrations();
    expect((await database().query('SELECT count(*)::integer AS n FROM fresh_me.print_jobs')).rows[0].n).toBe(1);
  }finally{await db.stop();}
});
async function legacySchema(client){
  await client.query('CREATE SCHEMA fresh_me');
  await client.query('CREATE TABLE fresh_me.schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz DEFAULT now())');
  for(const name of ['001_initial.sql','002_machine_isolation.sql']){
    const sql=await readFile(new URL('../migrations/'+name,import.meta.url),'utf8');await client.query(sql);
    await client.query('INSERT INTO fresh_me.schema_migrations(name,checksum) VALUES ($1,$2)',[name,createHash('sha256').update(sql).digest('hex')]);
  }
}
it('does not promote formerly restricted staff when removing roles',async()=>{
  const db=await testDatabase({beforeMigrate:async client=>{
    await legacySchema(client);
    await client.query("INSERT INTO fresh_me.admins(_id,email,\"passwordHash\",role) VALUES ('staff','staff@qa.invalid','fixture','MANAGER')");
  }});
  try{expect((await database().query("SELECT disabled,\"sessionVersion\",role,\"shopId\" FROM fresh_me.admins WHERE _id='staff'")).rows[0]).toMatchObject({disabled:true,sessionVersion:2,role:'CLIENT_ADMIN',shopId:'shop'});}finally{await db.stop();}
});
it('refuses to silently merge non-default business data',async()=>{
  await expect(testDatabase({beforeMigrate:async client=>{
    await legacySchema(client);
    await client.query("INSERT INTO fresh_me.machines(_id,code,name) VALUES ('other','OTHER','Other')");
    await client.query("INSERT INTO fresh_me.products(_id,name,category,\"flavorColor\",sizes,\"machineId\") VALUES ('other-product','QA','QA','#aa2277','[]','other')");
  }})).rejects.toThrow('reviewed consolidation');
});
it('rejects an unknown release history before applying pending migrations',async()=>{
  const db=await testDatabase();
  try {
    await database().query("INSERT INTO fresh_me.schema_migrations(name,checksum) VALUES ('006_per_shop_razorpay.sql','foreign-release')");
    await database().query("DELETE FROM fresh_me.schema_migrations WHERE name='005_editable_shop_urls.sql'");
    const before=(await database().query('SELECT name,checksum FROM fresh_me.schema_migrations ORDER BY name')).rows;
    await expect(verifyMigrations()).rejects.toMatchObject({code:'MIGRATION_HISTORY_MISMATCH'});
    await expect(migrate()).rejects.toMatchObject({code:'MIGRATION_HISTORY_MISMATCH'});
    expect((await database().query('SELECT name,checksum FROM fresh_me.schema_migrations ORDER BY name')).rows).toEqual(before);
    expect((await database().query("SELECT count(*)::int AS count FROM fresh_me.shops")).rows[0].count).toBe(1);
  } finally {await db.stop();}
});
