import {beforeAll,afterAll,beforeEach,it,expect} from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import {randomUUID} from 'node:crypto';
import {testDatabase,resetDatabase} from './database-helper.js';
import {createApp} from '../src/app.js';
import {database} from '../src/database.js';
import {Settings,Admin,Product,PrintJob} from '../src/models.js';
import {keyHash} from '../src/agent-controls.js';
import {createOrder,orderInput} from '../src/payments.js';
import {claimJobs} from '../src/agent-api.js';
let db,app,product,cookie,gateway;
const password='QA-Strong-Password-91!';
const config={NODE_ENV:'test',TRUST_PROXY:0,CLIENT_ORIGIN:'http://localhost:5173',JWT_SECRET:'qa-session-secret'.repeat(3),AGENT_KEY:'qa-agent-key'.repeat(4),AGENT_FILE_MODE_ALLOWED:true,RAZORPAY_KEY_ID:'rzp_test_qa',RAZORPAY_KEY_SECRET:'qa-secret',RAZORPAY_WEBHOOK_SECRET:'qa-webhook-secret'};
const body=extra=>({idempotencyKey:randomUUID(),phone:'9999900001',customerName:'QA-TEST',items:[{productId:product._id,size:'Small',qty:1}],...extra});
const admin=(method,url,data)=>{let r=request(app)[method]('/api/admin'+url).set('Cookie',cookie).set('Origin',config.CLIENT_ORIGIN);return data===undefined?r:r.send(data);};
const agent=(method,url,data,key=config.AGENT_KEY)=>{let r=request(app)[method]('/api/agent'+url).set('x-agent-key',key);return data===undefined?r:r.send(data);};
beforeAll(async()=>{db=await testDatabase();});afterAll(async()=>{await db?.stop();});
beforeEach(async()=>{
  await resetDatabase();
  product=await Product.create({name:'QA Test Slush',category:'QA-TEST',flavorColor:'#aa2277',sizes:[{label:'Small',price:1}],available:true});
  await Admin.create({email:'admin@qa.invalid',passwordHash:await bcrypt.hash(password,4)});
  gateway={orders:{create:async({receipt})=>({id:'order_'+receipt})},payments:{fetch:async()=>{throw new Error('Unmocked gateway');}}};
  app=createApp({config,gateway,logger:{error(){},info(){}},imageStorage:{}});
  cookie=(await request(app).post('/api/admin/login').send({email:'admin@qa.invalid',password})).headers['set-cookie'][0].split(';')[0];
});
it('removes routing, role fields and user management from the single-shop API and database',async()=>{
  for(const endpoint of ['/machines','/users'])for(const method of ['get','post'])expect((await admin(method,endpoint,method==='post'?{}:undefined)).status).toBe(404);
  expect((await admin('get','/me')).body).toEqual({email:'admin@qa.invalid'});
  expect((await database().query("SELECT to_regclass('fresh_me.machines') AS t")).rows[0].t).toBeNull();
  expect((await database().query("SELECT column_name FROM information_schema.columns WHERE table_schema='fresh_me' AND column_name IN ('machineId','machineIds','role')")).rows).toEqual([]);
  expect(orderInput.safeParse(body({machineCode:'DEFAULT'})).success).toBe(false);
});
it('cached menus immediately reflect product edits and shop pauses',async()=>{
  expect((await request(app).get('/api/menu')).body.products[0].available).toBe(true);
  expect((await admin('patch','/products/'+product._id+'/availability',{available:false})).status).toBe(200);
  expect((await request(app).get('/api/menu')).body.products[0].available).toBe(false);
  await Settings.updateOne({_id:'shop'},{acceptingOrders:false});
  expect((await request(app).get('/api/menu')).body.settings.acceptingOrders).toBe(false);
  await expect(createOrder(body(),gateway,config)).rejects.toMatchObject({status:409});
  expect((await request(app).get('/api/menu?machineCode[x]=oops')).status).toBe(400);
});
it('does not claim false/offline polls, fences stale claims and makes done idempotent',async()=>{
  const job=await PrintJob.create({type:'TEST'});
  for(const query of ['?claim=false&printer=online','?printer=offline'])expect((await agent('get','/jobs'+query)).body).toEqual([]);
  expect((await PrintJob.findById(job._id)).status).toBe('PENDING');
  const [claimed]=(await agent('get','/jobs')).body;
  for(const action of ['renew','done','failed'])expect((await agent('post',`/jobs/${job._id}/${action}`,{claimId:randomUUID()})).status).toBe(409);
  for(let i=0;i<2;i++)expect((await agent('post',`/jobs/${job._id}/done`,{claimId:claimed.claimId})).status).toBe(200);
});
it('keeps transient errors pending and fails hard print errors at five attempts',async()=>{
  const original=await PrintJob.create({type:'TEST'});
  for(const reason of ['PRINTER_OFFLINE','PAPER_OUT','COVER_OPEN','NETWORK']){
    for(let i=0;i<2;i++){const [j]=await claimJobs(1);expect((await agent('post',`/jobs/${j._id}/failed`,{claimId:j.claimId,reason})).status).toBe(200);}
    expect(await PrintJob.findById(original._id)).toMatchObject({status:'PENDING',attempts:0});
  }
  for(let i=0;i<5;i++){const [j]=await claimJobs(1);await agent('post',`/jobs/${j._id}/failed`,{claimId:j.claimId,reason:'PRINT_ERROR'});}
  expect(await PrintJob.findById(original._id)).toMatchObject({attempts:5,status:'FAILED'});
});
it('long polls with bounded batches and expires empty waits',async()=>{
  await Settings.updateOne({_id:'shop'},{batchSize:1});
  const pending=agent('get','/jobs?wait=2').then(r=>r);
  await new Promise(r=>setTimeout(r,600));await PrintJob.create([{type:'TEST'},{type:'TEST'}]);
  expect((await pending).body).toHaveLength(1);await claimJobs(20);
  const start=Date.now();expect((await agent('get','/jobs?wait=1')).body).toEqual([]);
  expect(Date.now()-start).toBeGreaterThanOrEqual(900);expect(Date.now()-start).toBeLessThan(4000);
});
it('config ETag tracks receipt settings, not heartbeat, and file output is never allowed in production',async()=>{
  const r=await agent('get','/config');expect(r.body.filePrintingAllowed).toBe(true);
  await agent('post','/heartbeat',{printer:'online',version:'1.1.0',battery:80});
  expect((await request(app).get('/api/agent/config').set('x-agent-key',config.AGENT_KEY).set('If-None-Match',r.headers.etag)).status).toBe(304);
  const settings={shopName:'QA Receipt',tagline:'QA',acceptingOrders:true,receiptHeader:'QA header',receiptFooter:'QA footer',prepCopy:true,batchSize:2};
  const saved=await admin('put','/settings',settings);expect(saved.status).toBe(200);expect(saved.body).not.toHaveProperty('agentKeyHash');
  const next=await agent('get','/config');expect(next.headers.etag).not.toBe(r.headers.etag);expect(next.body).toMatchObject({shopName:'QA Receipt',prepCopy:true,batchSize:2});
  const prod=createApp({config:{...config,NODE_ENV:'production'},gateway,logger:{error(){},info(){}},imageStorage:{}});
  expect((await request(prod).get('/api/agent/config').set('x-agent-key',config.AGENT_KEY)).body.filePrintingAllowed).toBe(false);
});
it('caps events at 200 and delivers unexpired commands once',async()=>{
  const events=Array.from({length:150},(_,i)=>({level:'info',message:'QA-TEST '+i}));
  for(let i=0;i<2;i++)expect((await agent('post','/events',{events})).status).toBe(200);
  expect((await admin('get','/agent/events')).body).toHaveLength(200);
  expect((await agent('post','/events',{events:Array(201).fill(events[0])})).status).toBe(400);
  const c=(await admin('post','/agent/commands',{type:'REFRESH_CONFIG'})).body;
  expect((await Promise.all([agent('get','/commands'),agent('get','/commands')])).flatMap(r=>r.body)).toHaveLength(1);
  expect((await agent('post',`/commands/${c._id}/ack`,{})).status).toBe(200);
  const expired=(await admin('post','/agent/commands',{type:'TEST_PRINT'})).body;
  await database().query('UPDATE fresh_me.agent_commands SET "expiresAt"=now()-interval \'1 second\' WHERE _id=$1',[expired._id]);
  expect((await agent('get','/commands')).body).toEqual([]);
  expect((await agent('post',`/commands/${expired._id}/ack`,{})).status).toBe(404);
});
it('pairing is once-only, expires and revokes the previous key',async()=>{
  const pairing=(await admin('post','/agent/pairing',{})).body;
  const r=await request(app).post('/api/agent/pair').send({code:pairing.code});expect(r.status).toBe(200);
  expect((await request(app).post('/api/agent/pair').send({code:pairing.code})).status).toBe(401);
  expect((await agent('get','/config')).status).toBe(401);expect((await agent('get','/config',undefined,r.body.agentKey)).status).toBe(200);
  expect((await admin('get','/settings')).body).not.toHaveProperty('agentKeyHash');
  const p2=(await admin('post','/agent/pairing',{})).body;
  await database().query('UPDATE fresh_me.agent_pairings SET "expiresAt"=now()-interval \'1 second\' WHERE "codeHash"=$1',[keyHash(p2.code)]);
  expect((await request(app).post('/api/agent/pair').send({code:p2.code})).status).toBe(401);
});
it('rejects bad phones and mass assignment, separates rate budgets and restricts script CSP',async()=>{
  for(const phone of ['12','abcdefghij','12345678901',{$gt:''}])expect(orderInput.safeParse(body({phone})).success).toBe(false);
  expect(orderInput.safeParse(body({phone:''})).success).toBe(true);
  expect(orderInput.safeParse(body({total:1,tokenNo:100,status:'PAID'})).success).toBe(false);
  for(let i=0;i<12;i++)expect((await request(app).post('/api/orders').send({})).status).toBe(400);
  expect((await request(app).post('/api/payments/verify').send({})).status).toBe(400);
  const csp=(await request(app).get('/healthz')).headers['content-security-policy'];expect(csp).not.toContain('unsafe-eval');expect(csp.split('script-src ')[1].split(';')[0]).not.toContain('unsafe-inline');expect(csp).not.toContain('*.razorpay.com');
});
it('revokes pending long polls when the agent key changes',async()=>{
  const pending=agent('get','/jobs?wait=3').then(r=>r);
  await new Promise(r=>setTimeout(r,500));await Settings.updateOne({_id:'shop'},{$inc:{keyVersion:1},$set:{agentKeyHash:keyHash('replacement')}});
  await PrintJob.create({type:'TEST'});expect((await pending).status).toBe(401);expect(await PrintJob.countDocuments({status:'PENDING'})).toBe(1);
});
it('public payment reconciliation redacts private fields and throttles fallback reads',async()=>{
  const pending=await createOrder(body(),gateway,config);let lookups=0;
  gateway.orders.fetch=async()=>{lookups++;return {status:'created'};};
  gateway.orders.fetchPayments=async()=>({items:[{id:'pay_'+pending.orderId,order_id:pending.razorpayOrderId,status:'captured',amount:100,currency:'INR'}]});
  for(let i=0;i<3;i++)expect((await request(app).get('/api/orders/'+pending.orderId)).status).toBe(200);
  expect(lookups).toBe(1);gateway.orders.fetch=async()=>({status:'paid'});
  const fresh=createApp({config,gateway,logger:{error(){},info(){}},imageStorage:{}});
  const r=await request(fresh).get('/api/orders/'+pending.orderId);expect(r.body.status).toBe('PAID');
  for(const field of ['phone','customerName','idempotencyKey','requestHash','razorpayOrderId','razorpayPaymentId','machine'])expect(r.body).not.toHaveProperty(field);
  expect(r.body.shopName).toBeTruthy();expect(r.body.tokenNo).toBe(1);expect(await PrintJob.countDocuments({orderId:pending.orderId,type:'ORDER'})).toBe(1);
});
it('passwords are case sensitive and disabled accounts cannot sign in',async()=>{
  const login=value=>request(app).post('/api/admin/login').send({email:'admin@qa.invalid',password:value});
  expect((await login(password.toLowerCase())).status).toBe(401);
  await Admin.updateOne({email:'admin@qa.invalid'},{disabled:true});expect((await login(password)).status).toBe(401);
});
