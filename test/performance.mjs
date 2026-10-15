// Optional local Lighthouse audit. Install its newer-Node tooling in .local/quality.
import { testDatabase } from './database-helper.js';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { seed } from '../src/seed.js';
const root=fileURLToPath(new URL('../../',import.meta.url));
const {default:lighthouse}=await import(pathToFileURL(path.join(root,'.local/quality/node_modules/lighthouse/core/index.js')));
const {launch}=await import(pathToFileURL(path.join(root,'.local/quality/node_modules/chrome-launcher/dist/index.js')));
let db,server,chrome;
try {
  db=await testDatabase();
  const config={NODE_ENV:'test',TRUST_PROXY:0,CLIENT_ORIGIN:'http://127.0.0.1:3101',JWT_SECRET:crypto.randomBytes(32).toString('hex'),AGENT_KEY:crypto.randomBytes(32).toString('hex'),ADMIN_EMAIL:'perf@example.com',ADMIN_PASSWORD:crypto.randomBytes(20).toString('hex'),AWS_REGION:'ap-south-1',S3_BUCKET:'fresh-me-test',S3_KEY_PREFIX:'fresh-me/products'};
  await seed(config);server=createApp({config,gateway:{},logger:{info(){},error(){}}}).listen(3101,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  chrome=await launch({chromePath:process.env.CHROME_PATH,chromeFlags:['--headless','--no-sandbox','--disable-gpu'],handleSIGINT:false});
  console.log('Running mobile Lighthouse against the built menu and real database…');
  const report=await lighthouse(config.CLIENT_ORIGIN,{port:chrome.port,output:'html',onlyCategories:['performance','accessibility','best-practices','seo'],logLevel:'error'});
  const output=path.join(root,'.local/qa');fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'lighthouse.html'),report.report);
  const scores=Object.fromEntries(Object.entries(report.lhr.categories).map(([key,value])=>[key,Math.round(value.score*100)]));
  const findings=Object.values(report.lhr.audits).filter(a=>a.score!==null && a.score<1).map(a=>({id:a.id,title:a.title,score:a.score,displayValue:a.displayValue,details:a.details}));
  fs.writeFileSync(path.join(output,'lighthouse-scores.json'),JSON.stringify(scores,null,2));fs.writeFileSync(path.join(output,'lighthouse-findings.json'),JSON.stringify(findings,null,2));console.log(JSON.stringify(scores));
} finally {await chrome?.kill();if(server)await new Promise(r=>server.close(r));await db?.stop();}
