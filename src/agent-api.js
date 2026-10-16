import {database,transaction} from './database.js';
import {Router} from 'express';
import rateLimit from 'express-rate-limit';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {z} from 'zod';
import {PrintJob,Settings} from './models.js';
import {asyncRoute,HttpError,safeEqual,objectId} from './utils.js';
import {keyHash} from './agent-controls.js';

export async function claimJobs(limit=5){
  const {rows}=await database().query(`WITH candidates AS (
    SELECT _id FROM fresh_me.print_jobs WHERE status='PENDING' OR (status='PRINTING' AND "claimedAt"<$1)
    ORDER BY "createdAt",_id LIMIT $2 FOR UPDATE SKIP LOCKED
  ) UPDATE fresh_me.print_jobs SET status='PRINTING',"claimedAt"=now(),"claimId"=$3,"updatedAt"=now()
  WHERE _id IN (SELECT _id FROM candidates) RETURNING *`,[new Date(Date.now()-60000),Math.max(1,Math.min(20,limit)),randomUUID()]);
  return rows.map(j=>({...j.payload,_id:j._id,type:j.type,orderId:j.orderId,claimId:j.claimId}));
}
const claimInput=z.object({claimId:z.string().uuid()}).strict();
const recoverable=new Set(['PRINTER_OFFLINE','PAPER_OUT','COVER_OPEN','NETWORK']);
const failure=z.object({claimId:z.string().uuid(),reason:z.enum([...recoverable,'PRINT_ERROR']).optional(),error:z.string().max(500).default('Print error')}).strict();
function reasonFor(body){
  if(body.reason)return body.reason;
  if(/paper/i.test(body.error))return 'PAPER_OUT';
  if(/cover/i.test(body.error))return 'COVER_OPEN';
  if(/offline|not connected/i.test(body.error))return 'PRINTER_OFFLINE';
  if(/network|ECONN|ENET|EHOST|fetch failed/i.test(body.error))return 'NETWORK';
  return 'PRINT_ERROR';
}
export function agentRouter(config){
  const router=Router();
  router.post('/pair',rateLimit({windowMs:60000,limit:20,legacyHeaders:false,standardHeaders:'draft-7'}),asyncRoute(async(req,res)=>{
    const {code}=z.object({code:z.string().regex(/^[a-f0-9]{48}$/)}).strict().parse(req.body);const key=randomBytes(32).toString('hex');
    await transaction(async client=>{
      // Lock in the same order as code creation to avoid a pairing/creation deadlock.
      await client.query("SELECT _id FROM fresh_me.settings WHERE _id='shop' FOR UPDATE");
      const {rows:[pair]}=await client.query('SELECT * FROM fresh_me.agent_pairings WHERE "codeHash"=$1 AND "usedAt" IS NULL AND "expiresAt">now() FOR UPDATE',[keyHash(code)]);
      if(!pair)throw new HttpError(401,'Pairing code is invalid or expired');
      await client.query('UPDATE fresh_me.settings SET "agentKeyHash"=$1,"keyVersion"="keyVersion"+1,"updatedAt"=now() WHERE _id=\'shop\'',[keyHash(key)]);
      await client.query('UPDATE fresh_me.agent_pairings SET "usedAt"=now() WHERE "codeHash"=$1',[keyHash(code)]);
    });res.json({agentKey:key});
  }));
  router.use(asyncRoute(async(req,res,next)=>{
    const key=req.get('x-agent-key');if(!key||key.length>256)throw new HttpError(401,'Agent key rejected');
    const settings=await Settings.findById('shop');
    const valid=settings?.agentKeyHash?safeEqual(keyHash(key),settings.agentKeyHash):settings?.keyVersion===0&&safeEqual(key,config.AGENT_KEY);
    if(!valid)throw new HttpError(401,'Agent key rejected');req.agentSettings=settings;next();
  }));
  const heartbeat=data=>Settings.updateOne({_id:'shop'},{$set:{agentLastSeenAt:new Date(),agentPrinterStatus:data.printer,...(data.version!==undefined?{agentVersion:data.version}:{}),...(data.battery!==undefined?{battery:data.battery}:{})}});
  router.post('/heartbeat',asyncRoute(async(req,res)=>{
    const data=z.object({printer:z.enum(['online','offline','unknown']),version:z.string().max(40).optional(),battery:z.number().int().min(0).max(100).nullable().optional()}).strict().parse(req.body);await heartbeat(data);res.json({ok:true});
  }));
  router.get('/config',asyncRoute(async(req,res)=>{
    const s=await Settings.findById('shop');
    const body={filePrintingAllowed:config.NODE_ENV!=='production'&&config.AGENT_FILE_MODE_ALLOWED===true,shopName:s.shopName,tagline:s.tagline,receiptHeader:s.receiptHeader,receiptFooter:s.receiptFooter,prepCopy:s.prepCopy,batchSize:s.batchSize};
    const etag='"'+createHash('sha256').update(JSON.stringify(body)).digest('hex')+'"';res.set('ETag',etag);
    if(req.get('if-none-match')?.split(',').map(x=>x.trim()).includes(etag))return res.status(304).end();res.json(body);
  }));
  router.get('/jobs',asyncRoute(async(req,res)=>{
    const q=z.object({printer:z.enum(['online','offline','unknown']).default('unknown'),claim:z.enum(['true','false']).default('true'),wait:z.coerce.number().int().min(0).max(20).default(0)}).strict().parse(req.query);
    await heartbeat(q);if(q.claim==='false'||q.printer==='offline')return res.json([]);
    const deadline=Date.now()+q.wait*1000;let closed=false;const close=()=>{closed=true;};res.on('close',close);
    try{do{
      if(closed)return;
      const s=await Settings.findById('shop');if(s.keyVersion!==req.agentSettings.keyVersion||s.agentKeyHash!==req.agentSettings.agentKeyHash)throw new HttpError(401,'Agent key rejected');
      const jobs=await claimJobs(s.batchSize);if(jobs.length||Date.now()>=deadline)return res.json(jobs);
      await new Promise(resolve=>setTimeout(resolve,Math.min(250,Math.max(1,deadline-Date.now()))));
    }while(!closed);}finally{res.off('close',close);}
  }));
  router.post('/jobs/:id/renew',asyncRoute(async(req,res)=>{
    const {claimId}=claimInput.parse(req.body),_id=objectId.parse(req.params.id);
    const result=await PrintJob.updateOne({_id,status:'PRINTING',claimId},{$set:{claimedAt:new Date()}});
    if(!result.matchedCount)throw new HttpError(409,'Print claim has expired');res.json({ok:true});
  }));
  router.post('/jobs/:id/done',asyncRoute(async(req,res)=>{
    const {claimId}=claimInput.parse(req.body),_id=objectId.parse(req.params.id),filter={_id,claimId};
    const job=await PrintJob.findOneAndUpdate({...filter,status:'PRINTING'},{$set:{status:'PRINTED',printedAt:new Date()}});
    if(!job&&!await PrintJob.exists({...filter,status:'PRINTED'}))throw new HttpError(409,'Print claim has expired');res.json({ok:true});
  }));
  router.post('/jobs/:id/failed',asyncRoute(async(req,res)=>{
    const _id=objectId.parse(req.params.id),body=failure.parse(req.body),reason=reasonFor(body),increment=recoverable.has(reason)?0:1;
    const {rows:[job]}=await database().query(`UPDATE fresh_me.print_jobs SET attempts=attempts+$3,status=CASE WHEN attempts+$3>=5 THEN 'FAILED' ELSE 'PENDING' END,"lastError"=$4,"updatedAt"=now() WHERE _id=$1 AND "claimId"=$2 AND status='PRINTING' RETURNING _id`,[_id,body.claimId,increment,`${reason}: ${body.error}`]);
    if(!job&&!await PrintJob.exists({_id,claimId:body.claimId,status:{$in:['PENDING','FAILED']}}))throw new HttpError(409,'Print claim has expired');res.json({ok:true});
  }));
  router.post('/events',asyncRoute(async(req,res)=>{
    const {events}=z.object({events:z.array(z.object({level:z.enum(['info','warn','error']),message:z.string().min(1).max(500)}).strict()).min(1).max(200)}).strict().parse(req.body);
    await transaction(async client=>{
      await client.query("SELECT _id FROM fresh_me.settings WHERE _id='shop' FOR UPDATE");
      for(const e of events)await client.query('INSERT INTO fresh_me.agent_events (level,message) VALUES ($1,$2)',[e.level,e.message.replaceAll(req.get('x-agent-key'),'[redacted]')]);
      await client.query('DELETE FROM fresh_me.agent_events WHERE _id NOT IN (SELECT _id FROM fresh_me.agent_events ORDER BY _id DESC LIMIT 200)');
    });res.json({ok:true,accepted:events.length});
  }));
  router.get('/commands',asyncRoute(async(req,res)=>{
    const {rows}=await database().query(`WITH ready AS (SELECT _id FROM fresh_me.agent_commands WHERE "deliveredAt" IS NULL AND "expiresAt">now() ORDER BY "createdAt" LIMIT 20 FOR UPDATE SKIP LOCKED) UPDATE fresh_me.agent_commands SET "deliveredAt"=now() WHERE _id IN (SELECT _id FROM ready) RETURNING _id,type,"expiresAt"`);res.json(rows);
  }));
  router.post('/commands/:id/ack',asyncRoute(async(req,res)=>{
    const {rowCount}=await database().query('UPDATE fresh_me.agent_commands SET "acknowledgedAt"=COALESCE("acknowledgedAt",now()) WHERE _id=$1 AND "deliveredAt" IS NOT NULL AND "expiresAt">now()',[objectId.parse(req.params.id)]);
    if(!rowCount)throw new HttpError(404,'Command not found or expired');res.json({ok:true});
  }));return router;
}
