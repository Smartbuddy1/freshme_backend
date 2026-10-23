// Real Express + real PostgreSQL transactions; only the external Razorpay SDK is faked.
import { chromium } from 'playwright-core';
import { testDatabase } from './database-helper.js';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { seed } from '../src/seed.js';
import { PrintJob, Order, Admin } from '../src/models.js';
const root = fileURLToPath(new URL('../../',import.meta.url));
const chromePath = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
const artifactDir = path.join(root,'.local','qa');fs.mkdirSync(artifactDir,{recursive:true});
const config={NODE_ENV:'test',PORT:3100,TRUST_PROXY:0,CLIENT_ORIGIN:'http://127.0.0.1:3100',JWT_SECRET:crypto.randomBytes(32).toString('hex'),AGENT_KEY:crypto.randomBytes(32).toString('hex'),RAZORPAY_KEY_ID:'rzp_test_browser',RAZORPAY_KEY_SECRET:'browser-secret',RAZORPAY_WEBHOOK_SECRET:'browser-webhook-secret',AWS_REGION:'ap-south-1',S3_BUCKET:'fresh-me-test',S3_KEY_PREFIX:'fresh-me/products',ADMIN_EMAIL:'qa@example.com',ADMIN_PASSWORD:crypto.randomBytes(20).toString('hex')};
const remoteOrders=new Map();
const gateway={orders:{create:async o=>{const id=`order_${o.receipt}`;remoteOrders.set(id,{...o,id});return {id};}},payments:{fetch:async id=>{const orderId=`order_${id.slice(4)}`;return {id,order_id:orderId,amount:remoteOrders.get(orderId).amount,currency:'INR',status:'captured',method:'card'};}}};
let db,server,browser;
const errors=[];const results=[];
try {
  db=await testDatabase();await seed(config);await Admin.updateOne({email:config.ADMIN_EMAIL},{role:'CLIENT_ADMIN',shopId:'shop'});
  const app=createApp({config,gateway,logger:{info(){},error(e){errors.push(JSON.stringify(e));}}});server=app.listen(3100,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  browser=await chromium.launch({...(chromePath && {executablePath:chromePath}),headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1,isMobile:true,hasTouch:true});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  page.setDefaultTimeout(15000);
  await page.addInitScript(()=>{if(!sessionStorage.getItem('qa-storage-seeded')){sessionStorage.setItem('qa-storage-seeded','true');sessionStorage.setItem('freshme-cart','{}');localStorage.setItem('freshme-name','42');localStorage.setItem('freshme-phone','{}');}});
  await page.route('https://checkout.razorpay.com/v1/checkout.js',route=>route.fulfill({contentType:'application/javascript',body:'window.Razorpay = class { constructor(options) { this.options = options; window.__checkout = options; window.__checkoutCount = (window.__checkoutCount || 0) + 1; } on(event, handler) { window.__paymentFailure = handler; } open() {} close() {} };'}));
  await page.goto(config.CLIENT_ORIGIN+'/fresh-me');await page.getByRole('button',{name:'Add Mango',exact:true}).waitFor();await page.screenshot({path:path.join(artifactDir,'menu-mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true);assert.equal(await page.locator('.product-slot').count(),6);results.push('390px menu: six products, no horizontal overflow');
  await page.getByRole('button',{name:'Add Mango',exact:true}).click();await page.getByRole('button',{name:'Pay',exact:true}).click();await page.getByRole('button',{name:'Medium',exact:true}).click();await page.getByRole('button',{name:'Increase Mango',exact:true}).click();await page.screenshot({path:path.join(artifactDir,'cart-mobile.png'),fullPage:true});
  await page.getByRole('button',{name:'Pay Rs.120',exact:true}).click();await page.waitForFunction(()=>window.__checkout);await page.evaluate(()=>window.__checkout.modal.ondismiss());await page.getByText('Checkout cancelled',{exact:true}).waitFor();
  const firstOrderId=await page.evaluate(()=>window.__checkout.order_id);await page.getByRole('button',{name:/^Retry/}).click();await page.waitForFunction(()=>window.__checkoutCount===2);assert.equal(await page.evaluate(()=>window.__checkout.order_id),firstOrderId);
  const paymentId=`pay_${firstOrderId.slice(6)}`;const signature=crypto.createHmac('sha256',config.RAZORPAY_KEY_SECRET).update(`${firstOrderId}|${paymentId}`).digest('hex');
  await page.evaluate(response=>window.__checkout.handler(response),{razorpay_order_id:firstOrderId,razorpay_payment_id:paymentId,razorpay_signature:signature});await page.getByText('Show this token at the counter',{exact:true}).waitFor();assert.equal(await page.locator('.token-number').innerText(),'001');await page.screenshot({path:path.join(artifactDir,'token-mobile.png'),fullPage:true});results.push('Cart sizes/quantity, cancelled checkout retry reuses gateway order, verified payment produces token 001');
  const order=await Order.findOne({razorpayOrderId:firstOrderId});assert.equal(order.total,120);assert.equal(await PrintJob.countDocuments(),1);
  const agentHeaders={'x-agent-key':config.AGENT_KEY};const jobs=await (await fetch(`${config.CLIENT_ORIGIN}/api/agent/jobs?printer=online`,{headers:agentHeaders})).json();
  await fetch(`${config.CLIENT_ORIGIN}/api/agent/jobs/${jobs[0]._id}/done`,{method:'POST',headers:{...agentHeaders,'Content-Type':'application/json'},body:JSON.stringify({claimId:jobs[0].claimId})});
  assert.equal((await (await fetch(config.CLIENT_ORIGIN + '/api/orders/' + order._id)).json()).printed, true);await page.reload();await page.getByText('Show this token at the counter',{exact:true}).waitFor();results.push('Printer acknowledgement updates order status; refresh restores the token');
  const admin=await context.newPage();admin.on('pageerror',e=>errors.push(e.message));await admin.goto(`${config.CLIENT_ORIGIN}/admin`);await admin.getByLabel('Email address').fill(config.ADMIN_EMAIL);await admin.getByLabel('Password',{exact:true}).fill(config.ADMIN_PASSWORD);await admin.getByRole('button',{name:'Login',exact:true}).click();await admin.getByRole('heading',{name:'A fresh start.'}).waitFor();await admin.screenshot({path:path.join(artifactDir,'admin-mobile.png'),fullPage:true});assert.equal(await admin.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true);
  await admin.setViewportSize({width:1440,height:960});await admin.screenshot({path:path.join(artifactDir,'admin-desktop.png'),fullPage:true});
  await admin.getByRole('link',{name:'Products',exact:true}).click();await admin.getByRole('button',{name:'Add New Flavor'}).click();await admin.getByLabel('Flavor Name').fill('Watermelon');await admin.getByRole('button',{name:'Save Flavor',exact:true}).click();await admin.getByText('Watermelon',{exact:true}).waitFor();results.push('Admin login, responsive dashboard and product creation');
  await admin.getByRole('link',{name:'Orders',exact:true}).click();await admin.getByRole('button',{name:'Reprint',exact:true}).click();await admin.getByText('Token #1 sent to printer',{exact:true}).waitFor();assert.equal((await admin.request.patch(`${config.CLIENT_ORIGIN}/api/admin/orders/${order._id}/serve`,{headers:{origin:config.CLIENT_ORIGIN},data:{}})).status(),200);await page.getByRole('heading',{name:/Now that/}).waitFor({timeout:10000});results.push('Admin reprint creates a duplicate job; authenticated serve API updates the customer ticket');
  await admin.getByRole('link',{name:'Payments',exact:true}).click();await admin.locator('.payment-summary').getByText('Rs.120',{exact:true}).waitFor();const csv=await admin.request.get(`${config.CLIENT_ORIGIN}/api/admin/payments.csv?from=${new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(new Date())}`);assert.equal(csv.status(),200);assert.match(await csv.text(),/120/);results.push('Payments page and authenticated CSV export');
  await admin.getByRole('link',{name:'Settings',exact:true}).click();await admin.getByRole('switch',{name:/Storefront/}).click();await admin.getByText('Storefront ordering PAUSED',{exact:true}).waitFor();await page.goto(config.CLIENT_ORIGIN+'/fresh-me');await page.getByRole('heading',{name:'Shop is resting, back soon'}).waitFor();results.push('Shop closure reflected in customer UI');
  await admin.getByRole('switch',{name:/Storefront/}).click();await admin.getByText('Storefront is now OPEN for customer orders',{exact:true}).waitFor();
  const desktop=await context.newPage();await desktop.setViewportSize({width:1440,height:1000});await desktop.goto(config.CLIENT_ORIGIN+'/fresh-me');await desktop.getByRole('button',{name:'Add Mango',exact:true}).waitFor();await desktop.screenshot({path:path.join(artifactDir,'menu-desktop.png'),fullPage:true});
  for(const width of [360,430]) {await desktop.setViewportSize({width,height:900});await desktop.screenshot({path:path.join(artifactDir,`menu-${width}.png`),fullPage:true});assert.equal(await desktop.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true);}
  results.push('Menu checked at 360px, 390px, 430px and 1440px');
  if(process.env.RUN_LIGHTHOUSE==='1') {
    const {default:lighthouse}=await import(pathToFileURL(path.join(root,'.local/quality/node_modules/lighthouse/core/index.js')));const {launch}=await import(pathToFileURL(path.join(root,'.local/quality/node_modules/chrome-launcher/dist/index.js')));const chrome=await launch({chromePath:chromePath || browser.browserType().executablePath(),chromeFlags:['--headless','--no-sandbox']});
    try{const report=await lighthouse(config.CLIENT_ORIGIN,{port:chrome.port,output:'html',onlyCategories:['performance','accessibility','best-practices','seo'],logLevel:'error'});fs.writeFileSync(path.join(artifactDir,'lighthouse.html'),report.report);const scores=Object.fromEntries(Object.entries(report.lhr.categories).map(([k,v])=>[k,Math.round(v.score*100)]));results.push(`Lighthouse mobile: ${JSON.stringify(scores)}`);fs.writeFileSync(path.join(artifactDir,'lighthouse-scores.json'),JSON.stringify(scores,null,2));}finally{await chrome.kill();}
  }
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(artifactDir,'results.json'),JSON.stringify({results,errors},null,2));console.log(results.join('\n'));console.log('Browser checks passed. Screenshots saved in .local/qa.');
} finally {await browser?.close();if(server)await new Promise(r=>server.close(r));await db?.stop();}
