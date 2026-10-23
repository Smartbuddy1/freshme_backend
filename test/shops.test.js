import {beforeAll,afterAll,beforeEach,it,expect,vi} from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import {randomUUID,createHmac} from 'node:crypto';
import {testDatabase,resetDatabase} from './database-helper.js';
import {createApp} from '../src/app.js';
import {database} from '../src/database.js';
import {Shop,Settings,Admin,Product,Order,PrintJob} from '../src/models.js';
import {keyHash} from '../src/agent-controls.js';
import {createOrder,finalizePayment,orderInput} from '../src/payments.js';
import {setupSuperAdmin} from '../scripts/setup-super-admin.js';
import {istDate} from '../src/utils.js';
let db,app,a,b,pa,pb,owner,client,gateway,adminA,hash;
const password='QA-Strong-Password-91!',keyA='qa-alpha-key'.repeat(4),keyB='qa-bravo-key'.repeat(4);
const config={NODE_ENV:'test',TRUST_PROXY:0,CLIENT_ORIGIN:'http://localhost:5173',JWT_SECRET:'qa-session-secret'.repeat(3),AGENT_KEY:'qa-legacy-key'.repeat(4),RAZORPAY_KEY_ID:'rzp_test_shared',RAZORPAY_KEY_SECRET:'qa-secret',RAZORPAY_WEBHOOK_SECRET:'qa-webhook'};
const login=async(email,pw=password)=>(await request(app).post('/api/admin/login').send({email,password:pw}));
const cookie=r=>r.headers['set-cookie']?.[0].split(';')[0];
function auth(method,url,body,session=owner,shopId){let r=request(app)[method]('/api/admin'+url).set('Cookie',session).set('Origin',config.CLIENT_ORIGIN);if(shopId)r=r.set('X-Shop-Id',shopId);return body===undefined?r:r.send(body);}
function agent(method,url,body,key=keyA){let r=request(app)[method]('/api/agent'+url).set('X-Agent-Key',key);return body===undefined?r:r.send(body);}
const input=(shop,product,extra={})=>orderInput.parse({shopSlug:shop.slug,idempotencyKey:randomUUID(),items:[{productId:product._id,size:'Small',qty:1}],...extra});
async function paid(shop,product){const order=await createOrder(input(shop,product),gateway,config);const payment={id:'pay_'+order.orderId,order_id:order.razorpayOrderId,amount:order.amount,currency:'INR',status:'captured',method:'upi'};return {order,payment,paid:await finalizePayment(payment)};}
beforeAll(async()=>{db=await testDatabase();hash=await bcrypt.hash(password,4);});
afterAll(async()=>db?.stop());
beforeEach(async()=>{
  await resetDatabase();
  a=await Shop.create({name:'Alpha Juice',slug:'alpha-juice'});b=await Shop.create({name:'Bravo Juice',slug:'bravo-juice'});
  await Settings.create([{_id:a._id,shopName:a.name,acceptingOrders:true,agentKeyHash:keyHash(keyA),keyVersion:1},{_id:b._id,shopName:b.name,acceptingOrders:true,agentKeyHash:keyHash(keyB),keyVersion:1}]);
  const product={name:'QA Slush',category:'QA',flavorColor:'#aa2277',sizes:[{label:'Small',price:10}],available:true};
  pa=await Product.create({...product,shopId:a._id});pb=await Product.create({...product,name:'Bravo Slush',shopId:b._id});
  await Admin.create({email:'super@qa.invalid',passwordHash:hash,role:'SUPER_ADMIN',shopId:null});
  adminA=await Admin.create({email:'alpha@qa.invalid',passwordHash:hash,role:'CLIENT_ADMIN',shopId:a._id});
  gateway={orders:{create:vi.fn(async({receipt})=>({id:'order_'+receipt}))},payments:{fetch:vi.fn(async()=>{throw new Error('Unexpected gateway call');})}};
  app=createApp({config,gateway,logger:{error(){},info(){}},imageStorage:{upload:async()=>'/api/images/fixture'}});
  owner=cookie(await login('super@qa.invalid'));client=cookie(await login('alpha@qa.invalid'));
});
it('forces client scope, rejects role escalation and requires explicit super shop context',async()=>{
  expect((await auth('get','/me',undefined,client)).body).toMatchObject({role:'CLIENT_ADMIN',shopId:a._id,shop:{slug:a.slug}});
  for(const [method,url,body] of [['get','/platform/clients'],['post','/platform/clients',{}],['get','/platform/payments'],['get','/platform/payments.csv'],['get','/platform/reports'],['get','/platform/dashboard'],['put','/platform/settings',{}]])expect((await auth(method,url,body,client)).status).toBe(403);
  expect((await auth('get','/products',undefined,client,b._id)).status).toBe(403);
  expect((await auth('get','/products')).status).toBe(400);
  expect((await auth('get','/products',undefined,owner,b._id)).body.map(p=>p._id)).toEqual([pb._id]);
  expect((await auth('get','/products',undefined,client)).body.map(p=>p._id)).toEqual([pa._id]);
  expect((await auth('patch','/products/'+pb._id+'/availability',{available:false},client)).status).toBe(404);
  expect((await Product.findById(pb._id)).available).toBe(true);
  expect((await auth('post','/products',{...pa,role:'SUPER_ADMIN'},client)).status).toBe(400);
});
it('separates public menus, checkout IDs, paused shops and wrong-shop order lookups',async()=>{
  const menu=await request(app).get('/api/menu?shopSlug='+a.slug);expect(menu.body.products.map(p=>p._id)).toEqual([pa._id]);expect(menu.body.shop.slug).toBe(a.slug);
  expect((await request(app).get('/api/menu?shopSlug=missing-shop')).status).toBe(404);
  expect((await request(app).post('/api/orders').send(input(a,pb))).status).toBe(409);
  const payload=input(a,pa);const first=await request(app).post('/api/orders').send(payload);expect(first.status).toBe(201);
  expect((await request(app).post('/api/orders').send({...payload,shopSlug:b.slug,items:[{productId:pb._id,size:'Small',qty:1}]})).status).toBe(409);
  expect((await request(app).get('/api/orders/'+first.body.orderId+'?shopSlug='+b.slug)).status).toBe(404);
  expect((await request(app).get('/api/orders/'+first.body.orderId)).status).toBe(404);
  await Settings.updateOne({_id:a._id},{acceptingOrders:false});expect((await request(app).post('/api/orders').send(input(a,pa))).status).toBe(409);
  expect((await request(app).post('/api/orders').send(payload)).body.orderId).toBe(first.body.orderId);
  await Shop.updateOne({_id:a._id},{enabled:false});expect((await request(app).get('/api/menu?shopSlug='+a.slug)).status).toBe(404);
  expect((await request(app).get('/api/orders/'+first.body.orderId+'?shopSlug='+a.slug)).status).toBe(200);
});
it('uses one gateway account with per-shop tokens, immutable payment attribution and one original print',async()=>{
  const [one,two]=await Promise.all([paid(a,pa),paid(b,pb)]);
  expect(one.order.keyId).toBe(config.RAZORPAY_KEY_ID);expect(two.order.keyId).toBe(one.order.keyId);
  expect(one.paid.tokenNo).toBe(1);expect(two.paid.tokenNo).toBe(1);expect(one.paid.orderCode).not.toBe(two.paid.orderCode);
  await Promise.all([finalizePayment(one.payment),finalizePayment(one.payment)]);
  expect(await PrintJob.countDocuments({orderId:one.order.orderId})).toBe(1);
  expect((await PrintJob.findOne({orderId:one.order.orderId})).shopId).toBe(a._id);
  expect((await request(app).get('/api/orders/'+one.paid.orderCode+'?shopSlug='+b.slug)).status).toBe(404);
  const publicOrder=(await request(app).get('/api/orders/'+one.order.orderId+'?shopSlug='+a.slug)).body;
  expect(publicOrder.shop.id).toBe(a._id);for(const field of ['phone','customerName','requestHash','idempotencyKey','razorpayPaymentId'])expect(publicOrder).not.toHaveProperty(field);
  await expect(PrintJob.create({shopId:b._id,type:'REPRINT',orderId:one.order.orderId})).rejects.toMatchObject({code:'23503'});
});
it('checks shop ownership before gateway verification and credits signed webhook to original shop',async()=>{
  const order=await createOrder(input(a,pa),gateway,config);const payment={id:'pay_test',order_id:order.razorpayOrderId,amount:order.amount,currency:'INR',status:'captured',method:'upi'};
  const signature=createHmac('sha256',config.RAZORPAY_KEY_SECRET).update(order.razorpayOrderId+'|'+payment.id).digest('hex');
  expect((await request(app).post('/api/payments/verify').send({shopSlug:b.slug,orderId:order.orderId,razorpayOrderId:order.razorpayOrderId,paymentId:payment.id,signature})).status).toBe(400);expect(gateway.payments.fetch).not.toHaveBeenCalled();
  const raw=JSON.stringify({event:'payment.captured',payload:{payment:{entity:payment}}});const sig=createHmac('sha256',config.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
  for(let i=0;i<2;i++)expect((await request(app).post('/api/webhooks/razorpay').set('Content-Type','application/json').set('x-razorpay-signature',sig).send(raw)).status).toBe(200);
  expect((await Order.findById(order.orderId)).shopId).toBe(a._id);expect(await PrintJob.countDocuments({shopId:a._id})).toBe(1);expect(await PrintJob.countDocuments({shopId:b._id})).toBe(0);
});
it('isolates client orders, serve/reprint actions, reports, settings and CSV',async()=>{
  const [one,two]=await Promise.all([paid(a,pa),paid(b,pb)]);const range='?from='+istDate()+'&to='+istDate();
  const own=(await auth('get','/orders',undefined,client)).body.orders;expect(own.map(o=>o._id)).toEqual([one.paid._id]);
  expect((await auth('patch','/orders/'+two.paid._id+'/serve',{},client)).status).toBe(409);
  expect((await auth('post','/orders/'+two.paid._id+'/reprint',{},client)).status).toBe(409);
  expect((await auth('get','/reports'+range,undefined,client)).body.count).toBe(1);
  const csv=await auth('get','/payments.csv'+range,undefined,client);expect(csv.text).toContain(one.payment.id);expect(csv.text).not.toContain(two.payment.id);
  const ownSettings=(await auth('get','/settings',undefined,client)).body;expect(ownSettings.shopName).toBe(a.name);expect(ownSettings).not.toHaveProperty('agentKeyHash');
  expect((await auth('put','/settings',{shopName:'Renamed Alpha',tagline:'QA',acceptingOrders:true},client)).status).toBe(200);
  expect((await Shop.findById(a._id)).name).toBe('Renamed Alpha');expect((await Shop.findById(a._id)).slug).toBe(a.slug);expect((await Settings.findById(b._id)).shopName).toBe(b.name);
});
it('aggregates and filters shared payments without mixing client totals',async()=>{
  const one=await paid(a,pa);await paid(b,pb);await Order.updateOne({_id:one.paid._id},{refunded:true});
  const report=(await auth('get','/platform/reports')).body;expect(report.totals).toMatchObject({count:2,revenue:20,refundedOrders:1});expect(report.byShop.find(s=>s.shopId===a._id)).toMatchObject({count:1,revenue:10,refundedOrders:1});
  const filtered=(await auth('get','/platform/payments?shopId='+b._id)).body;expect(filtered.totals.count).toBe(1);expect(filtered.orders[0].shopId).toBe(b._id);
  const csv=await auth('get','/platform/payments.csv');expect(csv.text).toContain(a.name);expect(csv.text).toContain(b.name);
  expect((await auth('get','/platform/dashboard')).body).toMatchObject({clients:3,todayOrders:2,revenue:20});
});
it('returns five newest platform orders with shop names and keeps client history scoped',async()=>{
  expect((await auth('get','/platform/dashboard')).body.recentOrders).toEqual([]);
  const created=[];
  const now=Date.now();
  for(let i=0;i<7;i++){
    const shop=i%2?b:a,product=i%2?pb:pa;
    const order=await createOrder(input(shop,product),gateway,config);
    await Order.updateOne({_id:order.orderId},{createdAt:new Date(now-i*60000)});
    created.push(order.orderId);
  }
  const response=await auth('get','/platform/dashboard');
  expect(response.status).toBe(200);
  expect(response.body.recentOrders.map(order=>order._id)).toEqual(created.slice(0,5));
  expect(response.body.recentOrders[0]).toMatchObject({shopId:a._id,shopName:a.name,total:10,status:'PENDING_PAYMENT'});
  expect(response.body.recentOrders[1]).toMatchObject({shopId:b._id,shopName:b.name});
  for(const order of response.body.recentOrders){expect(order).not.toHaveProperty('phone');expect(order).not.toHaveProperty('razorpayPaymentId');}
  expect((await auth('get','/platform/dashboard?days=90')).body.recentOrders).toEqual(response.body.recentOrders);
  const own=(await auth('get','/dashboard',undefined,client)).body.orders;
  expect(own.map(order=>order._id)).toEqual(created.filter((_,i)=>i%2===0));
  expect(own.every(order=>order.shopId===a._id)).toBe(true);
});
it('charts all clients in IST days with zero-filled dates and bounded periods',async()=>{
  const first=await paid(a,pa),second=await paid(b,pb),outside=await paid(a,pa);
  const start=new Date(istDate()+'T00:00:00+05:30');
  await Order.updateOne({_id:first.paid._id},{paidAt:start,refunded:true});
  await Order.updateOne({_id:second.paid._id},{paidAt:new Date(+start-1)});
  await Order.updateOne({_id:outside.paid._id},{paidAt:new Date(+start-7*86400000)});
  await createOrder(input(b,pb),gateway,config); // Pending orders do not become revenue.
  const response=await auth('get','/platform/dashboard?days=7');expect(response.status).toBe(200);
  const data=response.body;expect(data.todayOrders).toBe(1);expect(data.revenue).toBe(10);
  expect(data.analytics.daily).toHaveLength(7);expect(data.analytics.totals).toEqual({orders:2,revenue:20});
  expect(data.analytics.daily.at(-1)).toMatchObject({date:istDate(),orders:1,revenue:10});
  expect(data.analytics.daily.at(-2)).toMatchObject({orders:1,revenue:10});
  expect(data.analytics.daily.slice(0,-2).every(row=>row.orders===0&&row.revenue===0)).toBe(true);
  expect(data.analytics.byShop.find(row=>row.shopId===a._id)).toMatchObject({count:1,revenue:10,refundedOrders:1});
  expect(data.analytics.byShop.find(row=>row.shopId===b._id)).toMatchObject({count:1,revenue:10});
  for(const days of [30,90]){const result=await auth('get','/platform/dashboard?days='+days);expect(result.body.analytics.daily).toHaveLength(days);expect(result.body.analytics.totals.orders).toBe(3);}
  for(const days of [0,8,366,'bad'])expect((await auth('get','/platform/dashboard?days='+days)).status).toBe(400);
  expect((await auth('get','/platform/dashboard?days=7',undefined,client)).status).toBe(403);
});
it('serves the same daily analytics for each admin scope without leaking another shop',async()=>{
  const first=await paid(a,pa),yesterday=await paid(a,pa),outside=await paid(a,pa);
  await paid(b,pb);
  const start=new Date(istDate()+'T00:00:00+05:30');
  await Order.updateOne({_id:first.paid._id},{paidAt:start,refunded:true});
  await Order.updateOne({_id:yesterday.paid._id},{paidAt:new Date(+start-1)});
  await Order.updateOne({_id:outside.paid._id},{paidAt:new Date(+start-7*86400000)});
  await createOrder(input(a,pa),gateway,config);
  expect((await auth('get','/dashboard?days=7',undefined,client,b._id)).status).toBe(403);
  const result=await auth('get','/dashboard?days=7',undefined,client);
  expect(result.status).toBe(200);
  expect(result.body.shopId).toBe(a._id);
  const series=result.body.analytics;
  expect(series.daily).toHaveLength(7);
  expect(series.totals).toEqual({orders:2,revenue:20});
  expect(series.daily.at(-1)).toEqual({date:istDate(),orders:1,revenue:10});
  expect(series.daily.at(-2)).toMatchObject({orders:1,revenue:10});
  expect(series.daily.slice(0,-2).every(row=>row.orders===0&&row.revenue===0)).toBe(true);
  expect((await auth('get','/dashboard?days=7',undefined,owner,a._id)).body.analytics).toEqual(series);
  expect((await auth('get','/dashboard?days=7',undefined,owner,b._id)).body.analytics.totals).toEqual({orders:1,revenue:10});
  for(const days of [30,90]){
    const response=await auth('get','/dashboard?days='+days,undefined,client);
    expect(response.body.analytics.daily).toHaveLength(days);
    expect(response.body.analytics.totals).toEqual({orders:3,revenue:30});
  }
  for(const days of [0,8,366,'bad'])expect((await auth('get','/dashboard?days='+days,undefined,client)).status).toBe(400);
});
it('creates client and admin atomically, allows editable shop IDs and prevents super role assignment',async()=>{
  const body={name:'Charlie Shop',slug:'charlie-shop',email:'charlie@qa.invalid',password};
  const created=await auth('post','/platform/clients',body);expect(created.status).toBe(201);const id=created.body.id;
  expect((await Settings.findById(id)).acceptingOrders).toBe(false);expect((await Admin.findOne({email:body.email})).role).toBe('CLIENT_ADMIN');
  expect((await auth('post','/platform/clients',{...body,slug:'duplicate-email'})).status).toBe(409);expect(await Shop.findOne({slug:'duplicate-email'})).toBeNull();
  expect((await auth('patch','/platform/clients/'+id,{slug:'changed-slug'})).status).toBe(200);
  expect((await auth('post','/platform/clients/'+id+'/admins',{email:'fake@qa.invalid',password,role:'SUPER_ADMIN'})).status).toBe(400);
  expect((await auth('patch',`/platform/clients/${b._id}/admins/${adminA._id}`,{disabled:true})).status).toBe(404);
  expect((await auth('patch',`/platform/clients/${a._id}/admins/${adminA._id}`,{password:'QA-New-Password-92!'})).status).toBe(200);
  expect((await auth('get','/me',undefined,client)).status).toBe(401);expect((await login('alpha@qa.invalid','QA-New-Password-92!')).status).toBe(200);
});
it('disables client sessions, login, menus, new orders and agent polling while preserving history',async()=>{
  const one=await paid(a,pa);expect((await auth('patch','/platform/clients/'+a._id,{enabled:false})).status).toBe(200);
  expect((await auth('get','/me',undefined,client)).status).toBe(401);expect((await login('alpha@qa.invalid')).status).toBe(401);
  expect((await agent('get','/config')).status).toBe(401);expect((await agent('get','/jobs')).status).toBe(401);
  expect((await request(app).post('/api/orders').send(input(a,pa))).status).toBe(404);
  expect((await request(app).get('/api/orders/'+one.order.orderId+'?shopSlug='+a.slug)).status).toBe(200);
  expect((await auth('get','/reports',undefined,owner,a._id)).body.count).toBe(1);
  expect((await agent('get','/config',undefined,keyB)).status).toBe(200);
});
it('binds agent keys to their own print leases, heartbeat, events and commands',async()=>{
  await paid(a,pa);await paid(b,pb);
  const [ja]=(await agent('get','/jobs')).body,[jb]=(await agent('get','/jobs',undefined,keyB)).body;
  expect(ja._id).not.toBe(jb._id);
  for(const action of ['renew','done','failed'])expect((await agent('post',`/jobs/${jb._id}/${action}`,{claimId:jb.claimId})).status).toBe(409);
  expect((await agent('post',`/jobs/${ja._id}/done`,{claimId:ja.claimId})).status).toBe(200);
  expect((await PrintJob.findById(jb._id)).status).toBe('PRINTING');
  await agent('post','/heartbeat',{printer:'offline',version:'alpha-version'});expect((await Settings.findById(a._id)).agentVersion).toBe('alpha-version');expect((await Settings.findById(b._id)).agentVersion).not.toBe('alpha-version');
  await agent('post','/events',{events:[{level:'info',message:'alpha-only'}]});expect((await auth('get','/agent/events',undefined,owner,b._id)).body).toEqual([]);
  const c=(await auth('post','/agent/commands',{type:'REFRESH_CONFIG'},owner,b._id)).body;expect((await agent('get','/commands')).body).toEqual([]);expect((await agent('get','/commands',undefined,keyB)).body[0]._id).toBe(c._id);expect((await agent('post','/commands/'+c._id+'/ack',{})).status).toBe(404);
});
it('pairs only the selected shop and leaves other shop and legacy keys intact',async()=>{
  const pairing=(await auth('post','/agent/pairing',{},client)).body;
  expect(pairing.shopId).toBe(a.slug);
  await agent('post','/heartbeat',{printer:'online'});
  expect((await request(app).post('/api/agent/pair').send({code:pairing.code,shopId:b._id})).status).toBe(401);
  const response=await request(app).post('/api/agent/pair').send({code:pairing.code});expect(response.status).toBe(200);
  expect(response.body.shopId).toBe(a._id);
  expect((await Settings.findById(a._id)).agentLastSeenAt).toBeNull();
  expect((await agent('get','/config')).status).toBe(401);expect((await agent('get','/config',undefined,response.body.agentKey)).body.shopName).toBe(a.name);
  expect((await agent('get','/config',undefined,keyB)).body.shopName).toBe(b.name);expect((await agent('get','/config',undefined,config.AGENT_KEY)).status).toBe(200);
  expect((await request(app).post('/api/agent/pair').send({code:pairing.code})).status).toBe(401);
  expect((await auth('get','/platform/clients')).text).not.toContain('agentKeyHash');
});
it('rejects mismatched explicit Shop ID before any heartbeat, print or command action',async()=>{
  const initial=await Settings.findById(a._id);
  for(const [method,url,body] of [['get','/config'],['get','/jobs'],['get','/commands'],['post','/heartbeat',{printer:'online'}],['post','/events',{events:[{level:'info',message:'wrong shop'}]}]]){
    let r=request(app)[method]('/api/agent'+url).set('x-agent-key',keyA).set('x-shop-id',b._id);
    if(body)r=r.send(body);expect((await r).status).toBe(403);
  }
  expect((await Settings.findById(a._id)).agentLastSeenAt).toEqual(initial.agentLastSeenAt);
  const correct=await request(app).get('/api/agent/config').set('x-agent-key',keyA).set('x-shop-id',a._id);
  expect(correct.status).toBe(200);expect(correct.body.shopId).toBe(a._id);
  expect((await request(app).get('/api/agent/jobs').set('x-shop-id',a._id)).status).toBe(401);
});
it('exposes identical shop-bound heartbeat state in client settings, dashboard and super clients',async()=>{
  await request(app).post('/api/agent/heartbeat').set('x-agent-key',keyA).set('x-shop-id',a._id).send({printer:'online',version:'test-shop-agent'}).expect(200);
  for(const endpoint of ['/settings','/dashboard']){
    const data=(await auth('get',endpoint,undefined,client)).body;
    expect(data).toMatchObject({shopId:endpoint==='/settings'?a.slug:a._id,agentPrinterStatus:'online'});expect(new Date(data.agentLastSeenAt).getTime()).toBeGreaterThan(Date.now()-5000);
  }
  const all=(await auth('get','/platform/clients')).body;
  expect(all.find(s=>s.id===a._id)).toMatchObject({agentPrinterStatus:'online',agentVersion:'test-shop-agent'});
  expect(all.find(s=>s.id===b._id).agentLastSeenAt).toBeNull();
});
it('bootstrap promotes only the selected active admin, preserves password and revokes prior session',async()=>{
  await setupSuperAdmin({ADMIN_EMAIL:'alpha@qa.invalid',ADMIN_PASSWORD:'Different-Password-99!'});
  const next=await Admin.findById(adminA._id);expect(next).toMatchObject({role:'SUPER_ADMIN',shopId:null,passwordHash:hash});
  expect((await auth('get','/me',undefined,client)).status).toBe(401);
  await setupSuperAdmin({ADMIN_EMAIL:'alpha@qa.invalid',ADMIN_PASSWORD:password});expect((await Admin.findById(adminA._id)).sessionVersion).toBe(next.sessionVersion);
  await Admin.updateOne({_id:adminA._id},{disabled:true});await expect(setupSuperAdmin({ADMIN_EMAIL:'alpha@qa.invalid',ADMIN_PASSWORD:password})).rejects.toThrow('disabled');
});
it('renames the URL and agent Shop ID while preserving old QR, order and printer attribution',async()=>{
  const orderInputA=input(a,pa);const order=await createOrder(orderInputA,gateway,config);
  const changed=await auth('patch','/platform/clients/'+a._id,{slug:'alpha-renamed',name:'Alpha New'});
  expect(changed.status).toBe(200);expect(changed.body.slug).toBe('alpha-renamed');
  for(const slug of [a.slug,'alpha-renamed']){
    const menu=await request(app).get('/api/menu?shopSlug='+slug);expect(menu.status).toBe(200);expect(menu.body.shop.slug).toBe('alpha-renamed');expect(menu.body.products[0]._id).toBe(pa._id);
    expect((await request(app).get('/api/orders/'+order.orderId+'?shopSlug='+slug)).status).toBe(200);
    expect((await createOrder({...orderInputA,shopSlug:slug},gateway,config)).orderId).toBe(order.orderId);
    const conf=await request(app).get('/api/agent/config').set('x-agent-key',keyA).set('x-shop-id',slug);
    expect(conf.status).toBe(200);expect(conf.body).toMatchObject({shopId:slug,shopSlug:'alpha-renamed'});
  }
  expect((await auth('get','/settings',undefined,client)).body.shopId).toBe('alpha-renamed');
  const pairing=(await auth('post','/agent/pairing',{},client)).body;expect(pairing.shopId).toBe('alpha-renamed');
  const paired=await request(app).post('/api/agent/pair').send({code:pairing.code,shopId:'alpha-renamed'});expect(paired.status).toBe(200);expect(paired.body.shopId).toBe('alpha-renamed');
  expect((await request(app).get('/api/agent/config').set('x-agent-key',keyB).set('x-shop-id','alpha-renamed')).status).toBe(403);
  expect((await Order.findById(order.orderId)).shopId).toBe(a._id);
});
it('reserves former URLs so another client cannot take over printed QR links',async()=>{
  await auth('patch','/platform/clients/'+a._id,{slug:'alpha-new'}).expect(200);
  for(const slug of [a.slug,'alpha-new',a._id]){
    expect((await auth('patch','/platform/clients/'+b._id,{slug,name:'Must roll back'})).status).toBe(409);
    expect((await Shop.findById(b._id)).name).toBe(b.name);
    expect((await auth('post','/platform/clients',{name:'Collision',slug,email:'collision@qa.invalid',password})).status).toBe(409);
  }
  expect((await auth('patch','/platform/clients/'+a._id,{slug:a.slug})).status).toBe(200);
  for(const slug of ['Bad Name','ab','../escape'])expect((await auth('patch','/platform/clients/'+a._id,{slug})).status).toBe(400);
  expect((await auth('patch','/platform/clients/'+a._id,{slug:'forbidden'},client)).status).toBe(403);
});
it('serializes conflicting URL edits so only one shop can own an identifier',async()=>{
  const results=await Promise.all([auth('patch','/platform/clients/'+a._id,{slug:'shared-name'}),auth('patch','/platform/clients/'+b._id,{slug:'shared-name'})]);
  expect(results.map(r=>r.status).sort()).toEqual([200,409]);
  const menu=await request(app).get('/api/menu?shopSlug=shared-name');expect(menu.status).toBe(200);
  expect(menu.body.products).toHaveLength(1);
});
