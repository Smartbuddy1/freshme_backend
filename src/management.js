import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { database, transaction } from './database.js';
import { Machine, Settings, Admin } from './models.js';
import { ownerOnly, publicMachine, machineCode, settingsId, keyHash, canAccess } from './machines.js';
import { asyncRoute, HttpError, objectId } from './utils.js';
export const passwordInput = z.string().min(12).max(128).refine(v => /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v) && /[^\w\s]/.test(v), 'Use upper/lowercase, a number and a symbol');
const machineInput = z.object({ code: machineCode, name: z.string().trim().min(1).max(60), isQa: z.boolean().default(false) }).strict();
export function managementRoutes(router) {
  router.get('/machines', asyncRoute(async (req,res) => {
    const machines = await Machine.find(req.admin.role === 'OWNER' ? {} : { _id: { $in: req.admin.machineIds } }).sort({ createdAt:1 });
    res.json(await Promise.all(machines.map(async m => { const s = await Settings.findById(settingsId(m._id)); return { ...publicMachine(m), acceptingOrders:s.acceptingOrders, printerStatus:s.agentPrinterStatus, lastSeen:s.agentLastSeenAt, online:Boolean(s.agentLastSeenAt && Date.now()-s.agentLastSeenAt<30000), version:s.agentVersion, battery:s.battery }; })));
  }));
  router.post('/machines', ownerOnly, asyncRoute(async (req,res) => {
    const input=machineInput.parse(req.body);
    try {
      const m=await transaction(async client=>{ const m=await Machine.create(input,client); await Settings.create({_id:m._id,shopName:m.name,acceptingOrders:false},client);return m; });
      res.status(201).json(publicMachine(m));
    } catch(e) { if(e.code==='23505')throw new HttpError(409,'Machine code already exists');throw e; }
  }));
  router.patch('/machines/:id', ownerOnly, asyncRoute(async(req,res)=>{
    const body=z.object({name:z.string().trim().min(1).max(60).optional(),enabled:z.boolean().optional()}).strict().refine(v=>Object.keys(v).length>0).parse(req.body);
    const m=await Machine.findByIdAndUpdate(req.params.id,body);if(!m)throw new HttpError(404,'Machine not found');res.json(publicMachine(m));
  }));
  router.post('/machines/:id/pairing', ownerOnly, asyncRoute(async(req,res)=>{
    const code=randomBytes(24).toString('hex');
    const expiresAt=await transaction(async client=>{
      const {rows:[m]}=await client.query('SELECT _id FROM fresh_me.machines WHERE _id=$1 AND enabled FOR UPDATE',[req.params.id]);if(!m)throw new HttpError(404,'Machine not found');
      await client.query('DELETE FROM fresh_me.agent_pairings WHERE "machineId"=$1',[m._id]);
      return (await client.query('INSERT INTO fresh_me.agent_pairings ("codeHash","machineId","expiresAt") VALUES ($1,$2,now()+interval \'10 minutes\') RETURNING "expiresAt"',[keyHash(code),m._id])).rows[0].expiresAt;
    });
    res.status(201).json({code,expiresAt});
  }));
  router.get('/machines/:id/events', asyncRoute(async(req,res)=>{
    if(!canAccess(req.admin,req.params.id))throw new HttpError(403,'Machine access denied');
    res.json((await database().query('SELECT _id,level,message,"createdAt" FROM fresh_me.agent_events WHERE "machineId"=$1 ORDER BY _id DESC LIMIT 200',[req.params.id])).rows);
  }));
  router.post('/machines/:id/commands', ownerOnly, asyncRoute(async(req,res)=>{
    const {type}=z.object({type:z.enum(['REFRESH_CONFIG','TEST_PRINT'])}).strict().parse(req.body);
    if(!await Machine.exists({_id:req.params.id,enabled:true}))throw new HttpError(404,'Machine not found');
    const {rows:[command]}=await database().query('INSERT INTO fresh_me.agent_commands (_id,"machineId",type) VALUES ($1,$2,$3) RETURNING _id,type,"expiresAt"',[randomBytes(12).toString('hex'),req.params.id,type]);res.status(201).json(command);
  }));
  router.get('/users',ownerOnly,asyncRoute(async(req,res)=>res.json(await Admin.find().select('email role machineIds disabled'))));
  router.post('/users',ownerOnly,asyncRoute(async(req,res)=>{
    const body=z.object({email:z.string().email().max(254).transform(v=>v.toLowerCase()),password:passwordInput,role:z.enum(['OWNER','MANAGER']),machineIds:z.array(z.string().min(1).max(50)).max(100).default([])}).strict().parse(req.body);
    if(body.role==='MANAGER'&&!body.machineIds.length)throw new HttpError(400,'Assign at least one machine');
    for(const id of body.machineIds)if(!await Machine.exists({_id:id}))throw new HttpError(400,'Unknown machine assignment');
    try{const user=await Admin.create({email:body.email,passwordHash:await bcrypt.hash(body.password,12),role:body.role,machineIds:[...new Set(body.machineIds)]});res.status(201).json({_id:user._id,email:user.email,role:user.role,machineIds:user.machineIds});}
    catch(e){if(e.code==='23505')throw new HttpError(409,'Account already exists');throw e;}
  }));
  router.patch('/users/:id',ownerOnly,asyncRoute(async(req,res)=>{
    const id=objectId.parse(req.params.id);if(id===req.admin._id)throw new HttpError(409,'Use your account page; self-access changes are not allowed');
    const body=z.object({disabled:z.boolean().optional(),machineIds:z.array(z.string().min(1).max(50)).max(100).optional()}).strict().refine(v=>Object.keys(v).length>0).parse(req.body);
    for(const machine of body.machineIds||[])if(!await Machine.exists({_id:machine}))throw new HttpError(400,'Unknown machine assignment');
    const user=await Admin.findById(id);if(!user)throw new HttpError(404,'User not found');
    if(user.role==='MANAGER'&&body.machineIds?.length===0&&!body.disabled)throw new HttpError(400,'Assign at least one machine or disable the account');
    await Admin.updateOne({_id:id},{$set:body,$inc:{sessionVersion:1}});res.json({ok:true});
  }));
}
