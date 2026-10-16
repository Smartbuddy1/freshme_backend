import {randomBytes,createHash} from 'node:crypto';
import {z} from 'zod';
import {database,transaction} from './database.js';
import {asyncRoute} from './utils.js';
export const keyHash=value=>createHash('sha256').update(value).digest('hex');
export const passwordInput=z.string().min(12).max(128).refine(v=>/[a-z]/.test(v)&&/[A-Z]/.test(v)&&/\d/.test(v)&&/[^\w\s]/.test(v),'Use upper/lowercase, a number and a symbol');
export function agentControlRoutes(router){
  router.post('/agent/pairing',asyncRoute(async(req,res)=>{
    const code=randomBytes(24).toString('hex');
    const expiresAt=await transaction(async client=>{
      await client.query("SELECT _id FROM fresh_me.settings WHERE _id='shop' FOR UPDATE");
      await client.query('DELETE FROM fresh_me.agent_pairings');
      return (await client.query('INSERT INTO fresh_me.agent_pairings ("codeHash","expiresAt") VALUES ($1,now()+interval \'10 minutes\') RETURNING "expiresAt"',[keyHash(code)])).rows[0].expiresAt;
    });res.status(201).json({code,expiresAt});
  }));
  router.get('/agent/events',asyncRoute(async(req,res)=>res.json((await database().query('SELECT _id,level,message,"createdAt" FROM fresh_me.agent_events ORDER BY _id DESC LIMIT 200')).rows)));
  router.post('/agent/commands',asyncRoute(async(req,res)=>{
    const {type}=z.object({type:z.enum(['REFRESH_CONFIG','TEST_PRINT'])}).strict().parse(req.body);
    const {rows:[command]}=await database().query('INSERT INTO fresh_me.agent_commands (_id,type) VALUES ($1,$2) RETURNING _id,type,"expiresAt"',[randomBytes(12).toString('hex'),type]);res.status(201).json(command);
  }));
}
