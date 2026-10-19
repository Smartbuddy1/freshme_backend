import {randomBytes,randomInt,createHash} from 'node:crypto';
import {z} from 'zod';
import {database,transaction} from './database.js';
import {asyncRoute} from './utils.js';
export const keyHash=value=>createHash('sha256').update(value).digest('hex');
export const passwordInput=z.string().min(12).max(128).refine(v=>/[a-z]/.test(v)&&/[A-Z]/.test(v)&&/\d/.test(v)&&/[^\w\s]/.test(v),'Use upper/lowercase, a number and a symbol');
export function agentControlRoutes(router){
  router.post('/agent/pairing',asyncRoute(async(req,res)=>{
    let code;
    const expiresAt=await transaction(async client=>{
      await client.query('SELECT _id FROM fresh_me.shops WHERE _id=$1 FOR SHARE',[req.shopId]);
      await client.query('SELECT _id FROM fresh_me.settings WHERE _id=$1 FOR UPDATE',[req.shopId]);
      await client.query('DELETE FROM fresh_me.agent_pairings WHERE "shopId"=$1',[req.shopId]);
      let c, hash;
      for(let attempt=0;attempt<10;attempt++){
        c=String(randomInt(100000,1000000));
        hash=keyHash(c);
        const {rows}=await client.query('SELECT 1 FROM fresh_me.agent_pairings WHERE "codeHash"=$1',[hash]);
        if(!rows.length)break;
      }
      code=c;
      return (await client.query('INSERT INTO fresh_me.agent_pairings ("codeHash","shopId","expiresAt") VALUES ($1,$2,now()+interval \'10 minutes\') RETURNING "expiresAt"',[hash,req.shopId])).rows[0].expiresAt;
    });res.set('Cache-Control','no-store').status(201).json({code,expiresAt,shopId:req.shop.slug,shopName:req.shop.name});
  }));
  router.get('/agent/events',asyncRoute(async(req,res)=>res.json((await database().query('SELECT _id,level,message,"createdAt" FROM fresh_me.agent_events WHERE "shopId"=$1 ORDER BY _id DESC LIMIT 200',[req.shopId])).rows)));
  router.post('/agent/commands',asyncRoute(async(req,res)=>{
    const {type}=z.object({type:z.enum(['REFRESH_CONFIG','TEST_PRINT'])}).strict().parse(req.body);
    const {rows:[command]}=await database().query('INSERT INTO fresh_me.agent_commands (_id,type,"shopId") VALUES ($1,$2,$3) RETURNING _id,type,"expiresAt"',[randomBytes(12).toString('hex'),type,req.shopId]);res.status(201).json(command);
  }));
}
