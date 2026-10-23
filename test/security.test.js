import {beforeAll,afterAll,beforeEach,it,expect} from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import {testDatabase,resetDatabase} from './database-helper.js';
import {createApp} from '../src/app.js';
import {Admin,Shop,Settings} from '../src/models.js';
import {passwordInput} from '../src/passwords.js';

const password='QA-Strong-Password-91!';
const config={NODE_ENV:'test',TRUST_PROXY:1,CLIENT_ORIGIN:'http://localhost:5173',JWT_SECRET:'security-test-secret'.repeat(3),AGENT_KEY:'test-agent-key'.repeat(4),RAZORPAY_WEBHOOK_SECRET:'webhook-test'};
let db,app,hash,shop;
const login=(email='security@qa.invalid',pw=password,ip='192.0.2.1')=>request(app).post('/api/admin/login').set('X-Forwarded-For',ip).send({email,password:pw});
beforeAll(async()=>{db=await testDatabase();hash=await bcrypt.hash(password,4);});
afterAll(async()=>db?.stop());
beforeEach(async()=>{
  await resetDatabase();
  shop=await Shop.create({name:'Security QA',slug:'security-qa'});
  await Settings.create({_id:shop._id,shopName:shop.name});
  await Admin.create({email:'security@qa.invalid',passwordHash:hash,role:'SUPER_ADMIN',shopId:null});
  app=createApp({config,gateway:{},logger:{error(){},info(){}},imageStorage:{}});
});
it('rejects new passwords beyond bcrypt byte limit including multibyte text',async()=>{
  const boundary='Aa1!'+ 'x'.repeat(68);
  expect(passwordInput.safeParse(boundary).success).toBe(true);
  expect(passwordInput.safeParse(boundary+'y').success).toBe(false);
  expect(passwordInput.safeParse('Aa1!'+'\u00e9'.repeat(35)).success).toBe(false);
  const cookie=(await login()).headers['set-cookie'];
  const response=await request(app).post('/api/admin/change-password').set('Cookie',cookie).send({currentPassword:password,newPassword:boundary+'y'});
  expect(response.status).toBe(400);
  expect(await bcrypt.compare(password,(await Admin.findOne({email:'security@qa.invalid'})).passwordHash)).toBe(true);
});
it('limits distributed login guesses for the same case-normalized account',async()=>{
  for(let i=1;i<=20;i++)expect((await login(i%2?'SECURITY@qa.invalid':'security@qa.invalid','wrong-password',`192.0.2.${i}`)).status).toBe(401);
  expect((await login('security@qa.invalid',password,'192.0.2.21')).status).toBe(429);
  await Admin.create({email:'other@qa.invalid',passwordHash:hash,role:'SUPER_ADMIN',shopId:null});
  expect((await login('other@qa.invalid',password,'192.0.2.22')).status).toBe(200);
});
it('does not consume the account failure budget on successful sign-ins',async()=>{
  for(let i=1;i<=22;i++)expect((await login('security@qa.invalid',password,`192.0.2.${i}`)).status).toBe(200);
});
it('limits current-password guesses across IPs while leaving the session usable',async()=>{
  const cookie=(await login()).headers['set-cookie'];
  for(let i=1;i<=11;i++){
    const response=await request(app).post('/api/admin/change-password').set('Cookie',cookie).set('X-Forwarded-For',`192.0.2.${i}`).send({currentPassword:'wrong-password',newPassword:'Another-Strong-Password-92!'});
    expect(response.status).toBe(i<=10?400:429);
  }
  expect((await request(app).get('/api/admin/me').set('Cookie',cookie)).status).toBe(200);
});
it('rejects reserved shop routes on creation and rename without changing existing shops',async()=>{
  const cookie=(await login()).headers['set-cookie'];
  const count=await Shop.countDocuments();
  for(const slug of ['admin','super-admin','api','order','shop','fresheme','freshme','assets','healthz']){
    expect((await request(app).post('/api/admin/platform/clients').set('Cookie',cookie).send({name:'Reserved',slug,email:'new@qa.invalid',password})).status).toBe(400);
    expect((await request(app).patch('/api/admin/platform/clients/'+shop._id).set('Cookie',cookie).send({slug})).status).toBe(400);
  }
  expect(await Shop.countDocuments()).toBe(count);
  expect((await Shop.findById(shop._id)).slug).toBe(shop.slug);
  // Keep legacy URLs editable when the URL itself is unchanged.
  await Shop.updateOne({_id:shop._id},{slug:'admin'});
  expect((await request(app).patch('/api/admin/platform/clients/'+shop._id).set('Cookie',cookie).send({slug:'admin',name:'Legacy shop'})).status).toBe(200);
});
it('does not reflect malformed JSON secrets and prevents caching rejected requests',async()=>{
  const response=await request(app).post('/api/admin/login').set('Content-Type','application/json').send('{"password":"private-value",broken}');
  expect(response.status).toBe(400);
  expect(response.body).toEqual({error:'Invalid JSON body'});
  expect(response.headers['cache-control']).toBe('no-store');
  const webhook=await request(app).post('/api/webhooks/razorpay').send({event:'payment.captured'});
  expect(webhook.status).toBe(401);
  expect(webhook.headers['cache-control']).toBe('no-store');
});
it('enforces the login IP budget independently of account names and returns retry guidance',async()=>{
  for(let i=0;i<10;i++)expect((await login('not-an-email-'+i)).status).toBe(400);
  const blocked=await login();
  expect(blocked.status).toBe(429);
  expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  expect(blocked.headers['cache-control']).toBe('no-store');
  expect((await login('security@qa.invalid',password,'192.0.2.2')).status).toBe(200);
});
it('limits pairing guesses without consuming the admin login budget',async()=>{
  for(let i=0;i<20;i++)expect((await request(app).post('/api/agent/pair').send({code:'invalid'})).status).toBe(400);
  expect((await request(app).post('/api/agent/pair').send({code:'invalid'})).status).toBe(429);
  expect((await login()).status).toBe(200);
});
it('enforces order and payment limits separately so checkout abuse cannot starve verification',async()=>{
  for(let i=0;i<120;i++)expect((await request(app).post('/api/orders').send({})).status).toBe(400);
  expect((await request(app).post('/api/orders').send({})).status).toBe(429);
  for(let i=0;i<300;i++)expect((await request(app).post('/api/payments/verify').send({})).status).toBe(400);
  const blocked=await request(app).post('/api/payments/verify').send({});
  expect(blocked.status).toBe(429);
  expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  // Another network retains its budget; these responses are schema validation, not throttling.
  expect((await request(app).post('/api/orders').set('X-Forwarded-For','192.0.2.2').send({})).status).toBe(400);
  expect((await request(app).post('/api/payments/verify').set('X-Forwarded-For','192.0.2.2').send({})).status).toBe(400);
});
