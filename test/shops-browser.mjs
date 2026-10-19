// Real browser, Express and disposable PostgreSQL. Only Razorpay and paper output are simulated.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomBytes,createHmac} from 'node:crypto';
import bcrypt from 'bcryptjs';
import express from 'express';
import {chromium} from 'playwright-core';
import {testDatabase} from './database-helper.js';
import {createApp} from '../src/app.js';
import {Shop,Settings,Product,Admin,PrintJob,Order} from '../src/models.js';
import {keyHash} from '../src/agent-controls.js';

const results=[];const errors=[];const remote=new Map();
const secret=()=>randomBytes(32).toString('hex');
const config={NODE_ENV:'test',TRUST_PROXY:0,JWT_SECRET:secret(),AGENT_KEY:secret(),RAZORPAY_KEY_ID:'rzp_test_browser',RAZORPAY_KEY_SECRET:secret(),RAZORPAY_WEBHOOK_SECRET:secret()};
const gateway={orders:{create:async payload=>{const id='order_'+payload.receipt;remote.set(id,payload);return {id};}},payments:{fetch:async id=>({id,order_id:id.replace('pay_','order_'),amount:remote.get(id.replace('pay_','order_')).amount,currency:'INR',status:'captured',method:'upi'})}};
let db,server,browser;
try {
  db=await testDatabase();
  const app=createApp({config,gateway,logger:{info(){},error(){errors.push('API server error');}}});
  // Match the production Nginx prefix removal while retaining the browser's /freshme URL.
  const host=express();host.use((req,res,next)=>{if(req.url.startsWith('/freshme/api/'))req.url=req.url.slice('/freshme'.length);next();});host.use(app);
  server=host.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;config.CLIENT_ORIGIN=origin;
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync),headless:true});
  const shops=[];
  for(const [index,name] of ['Alpha','Bravo'].entries()) {
    const shop=await Shop.create({name:`QA ${name}`,slug:`qa-${name.toLowerCase()}`});
    const agentKey=secret(),password=secret();
    await Settings.create({_id:shop._id,shopName:shop.name,acceptingOrders:true,agentKeyHash:keyHash(agentKey),keyVersion:1});
    const product=await Product.create({shopId:shop._id,name:`${name} Slush`,category:'QA',flavorColor:'#aa2277',sizes:[{label:'Small',price:10+index}],available:true});
    const email=`${name.toLowerCase()}@qa.invalid`;
    await Admin.create({email,passwordHash:await bcrypt.hash(password,4),role:'CLIENT_ADMIN',shopId:shop._id});
    const context=await browser.newContext({viewport:{width:index?1440:390,height:900}});
    await context.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.origin===origin)return route.continue();
      if(url.href==='https://checkout.razorpay.com/v1/checkout.js')return route.fulfill({contentType:'application/javascript',body:'window.Razorpay=class{constructor(o){window.checkout=o;}on(){}open(){}close(){}}'});
      return route.abort();
    });
    const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`${origin}/freshme/fresheme/${shop.slug}`);
    await page.getByRole('button',{name:`Add ${product.name}`,exact:true}).click();
    await page.getByRole('button',{name:'Pay',exact:true}).click();
    await page.getByRole('button',{name:`Pay Rs.${10+index}`,exact:true}).click();
    await page.waitForFunction(()=>window.checkout);
    const checkout=await page.evaluate(()=>({orderId:window.checkout.order_id,amount:window.checkout.amount}));
    assert.equal(checkout.amount,(10+index)*100);
    shops.push({shop,product,agentKey,password,email,context,page,checkout});
  }
  results.push('Two shop-specific /freshme URLs load real menus and create correctly priced separate checkouts');
  await Promise.all(shops.map(async item=>{
    const paymentId=item.checkout.orderId.replace('order_','pay_');
    const signature=createHmac('sha256',config.RAZORPAY_KEY_SECRET).update(item.checkout.orderId+'|'+paymentId).digest('hex');
    await item.page.evaluate(response=>window.checkout.handler(response),{razorpay_order_id:item.checkout.orderId,razorpay_payment_id:paymentId,razorpay_signature:signature});
    await item.page.getByText('Show this token at the counter',{exact:true}).waitFor();
    assert.equal((await item.page.locator('.token-number').innerText()).trim(),'001');
    item.order=await Order.findOne({razorpayOrderId:item.checkout.orderId});
    assert.equal(item.order.shopId,item.shop._id);
    assert.equal(await PrintJob.countDocuments({shopId:item.shop._id,type:'ORDER'}),1);
    const payment=await gateway.payments.fetch(paymentId);
    const body=JSON.stringify({event:'payment.captured',payload:{payment:{entity:payment}}});
    const response=await fetch(origin+'/api/webhooks/razorpay',{method:'POST',headers:{'content-type':'application/json','x-razorpay-signature':createHmac('sha256',config.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex')},body});
    assert.equal(response.status,200);
    assert.equal(await PrintJob.countDocuments({orderId:item.order._id,type:'ORDER'}),1);
    await item.page.reload();await item.page.getByText('Show this token at the counter',{exact:true}).waitFor();
  }));
  results.push('Concurrent browser payments each receive token 001; duplicate signed webhooks create no duplicate receipt; reload preserves tokens');
  for(const item of shops) {
    const other=shops.find(other=>other!==item);
    assert.equal((await fetch(`${origin}/api/orders/${other.order._id}?shopSlug=${item.shop.slug}`)).status,404);
    const jobs=await (await fetch(origin+'/api/agent/jobs?printer=online',{headers:{'x-agent-key':item.agentKey}})).json();
    assert.equal(jobs.length,1);assert.equal(jobs[0].orderId,item.order._id);
    const done=await fetch(`${origin}/api/agent/jobs/${jobs[0]._id}/done`,{method:'POST',headers:{'x-agent-key':item.agentKey,'content-type':'application/json'},body:JSON.stringify({claimId:jobs[0].claimId})});assert.equal(done.status,200);
    const admin=await item.context.newPage();admin.setDefaultTimeout(15000);admin.on('pageerror',error=>errors.push(error.message));
    await admin.goto(origin+'/freshme/admin');await admin.getByLabel('Email address').fill(item.email);await admin.getByLabel('Password',{exact:true}).fill(item.password);await admin.getByRole('button',{name:/get pouring/}).click();
    await admin.getByRole('heading',{name:'A fresh start.',exact:true}).waitFor();
    assert.equal(await admin.locator('.admin-shop-context strong').innerText(),item.shop.name);
    const own=await admin.request.get(origin+'/api/admin/orders');assert.equal(own.status(),200);assert.deepEqual((await own.json()).orders.map(order=>order._id),[item.order._id]);
    assert.equal((await admin.request.get(origin+'/api/admin/orders',{headers:{'x-shop-id':other.shop._id}})).status(),403);
    assert.equal((await admin.request.get(origin+'/api/admin/platform/clients')).status(),403);
    const serve=await admin.request.patch(`${origin}/api/admin/orders/${item.order._id}/serve`,{headers:{origin},data:{}});assert.equal(serve.status(),200);
    await item.page.getByRole('heading',{name:"Now that's a happy sip!"}).waitFor();
    const csv=await admin.request.get(origin+'/api/admin/payments.csv');assert.equal(csv.status(),200);const text=await csv.text();assert(text.includes(item.order.razorpayPaymentId));assert(!text.includes(other.order.razorpayPaymentId));
    await admin.screenshot({path:`qa/evidence/launch-shop-${item.shop.slug}.png`,fullPage:true});
    assert.equal(await admin.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    results.push(`${item.shop.name}: isolated agent queue/acknowledgement, client login, orders and CSV; cross-shop/platform access rejected; serving updates customer UI`);
  }
  assert.deepEqual(errors,[]);
  console.log(results.join('\n'));
} catch(error){errors.push(error.message);throw error;}
finally {
  fs.writeFileSync('qa/evidence/launch-shops-browser.json',JSON.stringify({scope:'Local real browser/API/database; simulated Razorpay and printer acknowledgement',results,errors},null,2));
  await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await db?.stop();
}
