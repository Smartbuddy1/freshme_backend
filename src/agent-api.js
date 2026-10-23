import {database,transaction} from './database.js';
import {Router} from 'express';
import rateLimit from 'express-rate-limit';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {z} from 'zod';
import {PrintJob,Settings,Shop} from './models.js';
import {asyncRoute,HttpError,safeEqual,objectId} from './utils.js';
import {keyHash} from './agent-controls.js';
import {resolveShopIdentifier,shopSlug} from './shops.js';

export const jobNotifier=new EventEmitter();
jobNotifier.setMaxListeners(200);
export function notifyNewJob(shopId='shop'){
  jobNotifier.emit('job:any');
  jobNotifier.emit('job:shop');
  if(shopId)jobNotifier.emit('job:'+shopId);
}

export async function claimJobs(limit=5,shopId='shop'){
  const {rows}=await database().query(`WITH candidates AS (
    SELECT _id FROM fresh_me.print_jobs WHERE "shopId"=$4 AND (status='PENDING' OR (status='PRINTING' AND "claimedAt"<$1))
    ORDER BY "createdAt",_id LIMIT $2 FOR UPDATE SKIP LOCKED
  ) UPDATE fresh_me.print_jobs SET status='PRINTING',"claimedAt"=now(),"claimId"=$3,"updatedAt"=now()
  WHERE _id IN (SELECT _id FROM candidates) RETURNING *`,[new Date(Date.now()-60000),Math.max(1,Math.min(20,limit)),randomUUID(),shopId]);
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
    const {code,shopId}=z.object({code:z.string().regex(/^(\d{6,7}|[a-f0-9]{48})$/),shopId:shopSlug.optional()}).strict().parse(req.body);const key=randomBytes(32).toString('hex');
    const pairedShopId=await transaction(async client=>{
      const {rows:[candidate]}=await client.query('SELECT "shopId" FROM fresh_me.agent_pairings WHERE "codeHash"=$1',[keyHash(code)]);
      const requested=shopId?await resolveShopIdentifier(shopId,client):null;
      if(!candidate||(shopId&&candidate.shopId!==requested?._id))throw new HttpError(401,'Pairing code is invalid, expired or belongs to another shop');
      const {rows:[shop]}=await client.query('SELECT enabled FROM fresh_me.shops WHERE _id=$1 FOR SHARE',[candidate.shopId]);
      await client.query('SELECT _id FROM fresh_me.settings WHERE _id=$1 FOR UPDATE',[candidate.shopId]);
      const {rows:[pair]}=await client.query('SELECT * FROM fresh_me.agent_pairings WHERE "codeHash"=$1 AND "usedAt" IS NULL AND "expiresAt">now() FOR UPDATE',[keyHash(code)]);
      if(!pair||!shop?.enabled)throw new HttpError(401,'Pairing code is invalid or expired');
      await client.query('UPDATE fresh_me.settings SET "agentKeyHash"=$1,"keyVersion"="keyVersion"+1,"agentLastSeenAt"=NULL,"agentPrinterStatus"=\'unknown\',"agentVersion"=\'\',"updatedAt"=now() WHERE _id=$2',[keyHash(key),pair.shopId]);
      await client.query('UPDATE fresh_me.agent_pairings SET "usedAt"=now() WHERE "codeHash"=$1',[keyHash(code)]);
      return pair.shopId;
    });res.set('Cache-Control','no-store').json({agentKey:key,shopId:shopId||pairedShopId});
  }));
  router.use(asyncRoute(async(req,res,next)=>{
    const key=req.get('x-agent-key');if(!key||key.length>256)throw new HttpError(401,'Agent key rejected');
    let settings=await Settings.findOne({agentKeyHash:keyHash(key)});
    if(!settings&&safeEqual(key,config.AGENT_KEY)){
      const legacy=await Settings.findById('shop');
      if(legacy?.keyVersion===0&&!legacy.agentKeyHash)settings=legacy;
    }
    const shop=settings?await Shop.findById(settings._id):null;
    if(!shop?.enabled)throw new HttpError(401,'Agent key rejected');
    const requestedShop=req.get('x-shop-id');
    if(requestedShop&&(await resolveShopIdentifier(requestedShop))?._id!==shop._id)throw new HttpError(403,'Agent key does not belong to SHOP_ID');
    req.shopId=shop._id;req.agentSettings=settings;next();
  }));
  const heartbeat=(shopId,data)=>Settings.updateOne({_id:shopId},{$set:{agentLastSeenAt:new Date(),agentPrinterStatus:data.printer,...(data.version!==undefined?{agentVersion:data.version}:{}),...(data.battery!==undefined?{battery:data.battery}:{})}});
  router.post('/heartbeat',asyncRoute(async(req,res)=>{
    const data=z.object({printer:z.enum(['online','offline','unknown']),version:z.string().max(40).optional(),battery:z.number().int().min(0).max(100).nullable().optional()}).strict().parse(req.body);await heartbeat(req.shopId,data);res.json({ok:true});
  }));
  router.get('/config',asyncRoute(async(req,res)=>{
    const s=await Settings.findById(req.shopId);
    const shop=await Shop.findById(req.shopId);
    const body={shopId:req.get('x-shop-id')||shop.slug,shopSlug:shop.slug,filePrintingAllowed:config.NODE_ENV!=='production'&&config.AGENT_FILE_MODE_ALLOWED===true,shopName:s.shopName,tagline:s.tagline,receiptHeader:s.receiptHeader,receiptFooter:s.receiptFooter,prepCopy:s.prepCopy,batchSize:s.batchSize};
    const etag='"'+createHash('sha256').update(JSON.stringify(body)).digest('hex')+'"';res.set('ETag',etag);
    if(req.get('if-none-match')?.split(',').map(x=>x.trim()).includes(etag))return res.status(304).end();res.json(body);
  }));
  router.get('/jobs',asyncRoute(async(req,res)=>{
    const q=z.object({printer:z.enum(['online','offline','unknown']).default('unknown'),claim:z.enum(['true','false']).default('true'),wait:z.coerce.number().int().min(0).max(20).default(0)}).strict().parse(req.query);
    await heartbeat(req.shopId,q);if(q.claim==='false'||q.printer==='offline')return res.json([]);
    const deadline=Date.now()+q.wait*1000;let closed=false;const close=()=>{closed=true;};res.on('close',close);
    try{
      const s=await Settings.findById(req.shopId);
      if(!(await Shop.findById(req.shopId))?.enabled||s.keyVersion!==req.agentSettings.keyVersion||s.agentKeyHash!==req.agentSettings.agentKeyHash)throw new HttpError(401,'Agent key rejected');
      let jobs=await claimJobs(s.batchSize,req.shopId);
      if(jobs.length||Date.now()>=deadline||q.wait<=0)return res.json(jobs);
      while(!closed && Date.now()<deadline){
        await new Promise(resolve=>{
          let timer;
          const cleanup=()=>{
            clearTimeout(timer);
            jobNotifier.off('job:'+req.shopId,onJob);
            jobNotifier.off('job:any',onJob);
            jobNotifier.off('job:shop',onJob);
          };
          const onJob=()=>{cleanup();resolve();};
          jobNotifier.once('job:'+req.shopId,onJob);
          jobNotifier.once('job:any',onJob);
          jobNotifier.once('job:shop',onJob);
          const remaining=Math.max(1,Math.min(100,deadline-Date.now()));
          timer=setTimeout(()=>{cleanup();resolve();},remaining);
        });
        if(closed)return;
        jobs=await claimJobs(s.batchSize,req.shopId);
        if(jobs.length)return res.json(jobs);
      }
      return res.json([]);
    }finally{res.off('close',close);}
  }));
  router.post('/jobs/:id/renew',asyncRoute(async(req,res)=>{
    const {claimId}=claimInput.parse(req.body),_id=objectId.parse(req.params.id);
    const result=await PrintJob.updateOne({shopId:req.shopId,_id,status:'PRINTING',claimId},{$set:{claimedAt:new Date()}});
    if(!result.matchedCount)throw new HttpError(409,'Print claim has expired');res.json({ok:true});
  }));
  router.post('/jobs/:id/done',asyncRoute(async(req,res)=>{
    const {claimId}=claimInput.parse(req.body),_id=objectId.parse(req.params.id),filter={shopId:req.shopId,_id,claimId};
    const job=await PrintJob.findOneAndUpdate({...filter,status:'PRINTING'},{$set:{status:'PRINTED',printedAt:new Date()}});
    if(!job&&!await PrintJob.exists({...filter,status:'PRINTED'}))throw new HttpError(409,'Print claim has expired');res.json({ok:true});
  }));
  router.post('/jobs/:id/failed',asyncRoute(async(req,res)=>{
    const _id=objectId.parse(req.params.id),body=failure.parse(req.body),reason=reasonFor(body),increment=recoverable.has(reason)?0:1;
    const {rows:[job]}=await database().query(`UPDATE fresh_me.print_jobs SET attempts=attempts+$3,status=CASE WHEN attempts+$3>=5 THEN 'FAILED' ELSE 'PENDING' END,"lastError"=$4,"updatedAt"=now() WHERE _id=$1 AND "claimId"=$2 AND status='PRINTING' AND "shopId"=$5 RETURNING _id`,[_id,body.claimId,increment,`${reason}: ${body.error}`,req.shopId]);
    if(!job&&!await PrintJob.exists({shopId:req.shopId,_id,claimId:body.claimId,status:{$in:['PENDING','FAILED']}}))throw new HttpError(409,'Print claim has expired');res.json({ok:true});
  }));
  router.post('/events',asyncRoute(async(req,res)=>{
    const {events}=z.object({events:z.array(z.object({level:z.enum(['info','warn','error']),message:z.string().min(1).max(500)}).strict()).min(1).max(200)}).strict().parse(req.body);
    await transaction(async client=>{
      await client.query('SELECT _id FROM fresh_me.settings WHERE _id=$1 FOR UPDATE',[req.shopId]);
      for(const e of events)await client.query('INSERT INTO fresh_me.agent_events ("shopId",level,message) VALUES ($1,$2,$3)',[req.shopId,e.level,e.message.replaceAll(req.get('x-agent-key'),'[redacted]')]);
      await client.query('DELETE FROM fresh_me.agent_events WHERE "shopId"=$1 AND _id NOT IN (SELECT _id FROM fresh_me.agent_events WHERE "shopId"=$1 ORDER BY _id DESC LIMIT 200)',[req.shopId]);
    });res.json({ok:true,accepted:events.length});
  }));
  router.get('/commands',asyncRoute(async(req,res)=>{
    const {rows}=await database().query(`WITH ready AS (SELECT _id FROM fresh_me.agent_commands WHERE "shopId"=$1 AND "deliveredAt" IS NULL AND "expiresAt">now() ORDER BY "createdAt" LIMIT 20 FOR UPDATE SKIP LOCKED) UPDATE fresh_me.agent_commands SET "deliveredAt"=now() WHERE _id IN (SELECT _id FROM ready) RETURNING _id,type,"expiresAt"`,[req.shopId]);res.json(rows);
  }));
  router.post('/commands/:id/ack',asyncRoute(async(req,res)=>{
    const {rowCount}=await database().query('UPDATE fresh_me.agent_commands SET "acknowledgedAt"=COALESCE("acknowledgedAt",now()) WHERE _id=$1 AND "shopId"=$2 AND "deliveredAt" IS NOT NULL AND "expiresAt">now()',[objectId.parse(req.params.id),req.shopId]);
    if(!rowCount)throw new HttpError(404,'Command not found or expired');res.json({ok:true});
  }));return router;
}
