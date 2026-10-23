import bcrypt from 'bcryptjs';
import {z} from 'zod';
import {database,transaction} from './database.js';
import {Shop,Settings,Admin,Order,PrintJob,PlatformSettings,paymentSummary} from './models.js';
import {asyncRoute,HttpError,istDate,dayRange,dateString,csvCell,objectId} from './utils.js';
import {superOnly,shopSlug,shopView} from './shops.js';
import {passwordInput} from './agent-controls.js';
import {analyticsPeriod,dailyAnalytics} from './analytics.js';
const emailInput=z.string().trim().email().max(254).transform(v=>v.toLowerCase());
const clientInput=z.object({name:z.string().trim().min(1).max(60),slug:shopSlug,email:emailInput,password:passwordInput,tagline:z.string().trim().max(120).default('Sip and chill.')}).strict();
const rangeInput=z.object({from:dateString.default(istDate()),to:dateString.default(istDate()),shopId:z.string().min(1).max(80).optional(),page:z.coerce.number().int().min(1).max(100000).default(1)}).strict();
function dateRange(query){
  const q=rangeInput.parse(query);
  if(q.from>q.to||new Date(q.to)-new Date(q.from)>366*86400000)throw new HttpError(400,'Select a date range of up to one year');
  return {...q,range:{$gte:dayRange(q.from).$gte,$lt:dayRange(q.to).$lt}};
}
async function reportData(range,shopId){
  const values=[range.$gte,range.$lt];if(shopId)values.push(shopId);
  const {rows}=await database().query(`SELECT s._id AS "shopId",s.name AS "shopName",s.slug,
    count(o._id)::integer AS count,COALESCE(sum(o.total),0)::bigint AS revenue,
    count(o._id) FILTER(WHERE o.refunded)::integer AS "refundedOrders"
    FROM fresh_me.shops s LEFT JOIN fresh_me.orders o ON o."shopId"=s._id AND o."paidAt">=$1 AND o."paidAt"<$2
    ${shopId?'WHERE s._id=$3':''} GROUP BY s._id ORDER BY s.name`,values);
  return rows.map(row=>({...row,revenue:Number(row.revenue)}));
}
async function requireShop(id){const shop=await Shop.findById(id);if(!shop)throw new HttpError(404,'Client shop not found');return shop;}
function conflict(error){if(error.code==='23505')throw new HttpError(409,'That shop URL or email is already in use');throw error;}

export function platformRoutes(router){
  router.use('/platform',superOnly);
  router.get('/platform/dashboard',asyncRoute(async(req,res)=>{
    const period=analyticsPeriod(req.query),range=dayRange(period.to);
    const [shops,totals,pending,failed,byShop,periodShops,analytics,orders]=await Promise.all([Shop.find(),paymentSummary(range,null),PrintJob.countDocuments({status:{$in:['PENDING','PRINTING']}}),PrintJob.countDocuments({status:'FAILED'}),reportData(range),reportData(period.range),dailyAnalytics(period),Order.find().sort({createdAt:-1,_id:-1}).limit(5).lean()]);
    const recentOrders=orders.map(({_id,shopId,orderCode,tokenNo,total,status,refunded,createdAt})=>({_id,shopId,shopName:shops.find(shop=>shop._id===shopId)?.name,orderCode,tokenNo,total,status,refunded,createdAt}));
    res.json({clients:shops.length,activeClients:shops.filter(s=>s.enabled).length,todayOrders:totals[0].count,revenue:totals[0].revenue,pendingPrints:pending,failedPrints:failed,byShop,recentOrders,analytics:{...analytics,byShop:periodShops}});
  }));
  router.get('/platform/clients',asyncRoute(async(req,res)=>{
    const {rows}=await database().query(`SELECT s._id AS id,s.slug,s.name,s.enabled,s."createdAt",c."acceptingOrders",c."agentPrinterStatus",c."agentLastSeenAt",c."agentVersion",
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a._id,'email',a.email,'disabled',a.disabled) ORDER BY a.email) FROM fresh_me.admins a WHERE a."shopId"=s._id AND a.role='CLIENT_ADMIN'),'[]') AS admins
      FROM fresh_me.shops s JOIN fresh_me.settings c ON c._id=s._id ORDER BY s."createdAt",s._id`);
    res.json(rows);
  }));
  router.post('/platform/clients',asyncRoute(async(req,res)=>{
    const body=clientInput.parse(req.body),passwordHash=await bcrypt.hash(body.password,12);
    try{
      const shop=await transaction(async client=>{
        const shop=await Shop.create({name:body.name,slug:body.slug},client);
        await Settings.create({_id:shop._id,shopName:body.name,tagline:body.tagline,acceptingOrders:false},client);
        await Admin.create({email:body.email,passwordHash,role:'CLIENT_ADMIN',shopId:shop._id},client);
        return shop;
      });res.status(201).json(shopView(shop));
    }catch(e){conflict(e);}
  }));
  router.patch('/platform/clients/:id',asyncRoute(async(req,res)=>{
    const body=z.object({name:z.string().trim().min(1).max(60).optional(),slug:shopSlug.optional(),enabled:z.boolean().optional(),acceptingOrders:z.boolean().optional()}).strict().refine(v=>Object.keys(v).length>0).parse(req.body);
    await requireShop(req.params.id);
    try{await transaction(async client=>{
      await client.query('SELECT _id FROM fresh_me.shops WHERE _id=$1 FOR UPDATE',[req.params.id]);
      if(body.slug!==undefined)await client.query('UPDATE fresh_me.shops SET slug=$2,"updatedAt"=now() WHERE _id=$1',[req.params.id,body.slug]);
      if(body.name!==undefined){await client.query('UPDATE fresh_me.shops SET name=$2,"updatedAt"=now() WHERE _id=$1',[req.params.id,body.name]);await client.query('UPDATE fresh_me.settings SET "shopName"=$2,"updatedAt"=now() WHERE _id=$1',[req.params.id,body.name]);}
      if(body.enabled!==undefined){await client.query('UPDATE fresh_me.shops SET enabled=$2,"updatedAt"=now() WHERE _id=$1',[req.params.id,body.enabled]);if(!body.enabled)await client.query('UPDATE fresh_me.admins SET "sessionVersion"="sessionVersion"+1 WHERE "shopId"=$1',[req.params.id]);}
      if(body.acceptingOrders!==undefined)await client.query('UPDATE fresh_me.settings SET "acceptingOrders"=$2,"updatedAt"=now() WHERE _id=$1',[req.params.id,body.acceptingOrders]);
    });}catch(e){conflict(e);}res.json(shopView(await Shop.findById(req.params.id)));
  }));
  router.post('/platform/clients/:id/admins',asyncRoute(async(req,res)=>{
    const body=z.object({email:emailInput,password:passwordInput}).strict().parse(req.body);await requireShop(req.params.id);
    try{const admin=await Admin.create({email:body.email,passwordHash:await bcrypt.hash(body.password,12),role:'CLIENT_ADMIN',shopId:req.params.id});res.status(201).json({id:admin._id,email:admin.email,disabled:admin.disabled});}catch(e){conflict(e);}
  }));
  router.patch('/platform/clients/:id/admins/:adminId',asyncRoute(async(req,res)=>{
    const body=z.object({email:emailInput.optional(),password:passwordInput.optional(),disabled:z.boolean().optional()}).strict().refine(v=>Object.keys(v).length>0).parse(req.body);
    const values={};if(body.email!==undefined)values.email=body.email;if(body.disabled!==undefined)values.disabled=body.disabled;if(body.password)values.passwordHash=await bcrypt.hash(body.password,12);
    try{const admin=await Admin.findOneAndUpdate({_id:objectId.parse(req.params.adminId),shopId:req.params.id,role:'CLIENT_ADMIN'},{$set:values,$inc:{sessionVersion:1}});if(!admin)throw new HttpError(404,'Client admin not found');res.json({id:admin._id,email:admin.email,disabled:admin.disabled});}catch(e){conflict(e);}
  }));
  router.get('/platform/payments',asyncRoute(async(req,res)=>{
    const q=dateRange(req.query);if(q.shopId)await requireShop(q.shopId);
    const filter={paidAt:q.range,...(q.shopId?{shopId:q.shopId}:{})};
    const [orders,totals,shops]=await Promise.all([Order.find(filter).sort({paidAt:-1,_id:-1}).skip((q.page-1)*50).limit(50),paymentSummary(q.range,q.shopId||null),Shop.find()]);
    res.json({orders:orders.map(o=>({...o,shopName:shops.find(s=>s._id===o.shopId)?.name})),totals:totals[0],page:q.page,pages:Math.ceil(totals[0].count/50)});
  }));
  router.get('/platform/reports',asyncRoute(async(req,res)=>{
    const q=dateRange(req.query);if(q.shopId)await requireShop(q.shopId);
    const [totals,byShop]=await Promise.all([paymentSummary(q.range,q.shopId||null),reportData(q.range,q.shopId)]);
    res.json({totals:totals[0],byShop,from:q.from,to:q.to});
  }));
  router.get('/platform/payments.csv',asyncRoute(async(req,res)=>{
    const q=dateRange(req.query);if(q.shopId)await requireShop(q.shopId);
    const shops=await Shop.find();res.type('text/csv').attachment('fresh-me-all-clients-payments.csv');
    res.write(['Shop','Shop URL','Date (IST)','Order','Token','Amount (INR)','Status','Refunded','Payment ID'].map(csvCell).join(',')+'\r\n');
    for await(const o of Order.find({paidAt:q.range,...(q.shopId?{shopId:q.shopId}:{})}).sort({paidAt:-1,_id:-1}).cursor()){
      if(res.destroyed)break;const shop=shops.find(s=>s._id===o.shopId);
      const line=[shop?.name,shop?.slug,new Date(o.paidAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}),o.orderCode,o.tokenNo,o.total,o.status,o.refunded,o.razorpayPaymentId].map(csvCell).join(',')+'\r\n';
      if(!res.write(line))await new Promise(resolve=>{const ready=()=>{res.off('drain',ready);res.off('close',ready);resolve();};res.once('drain',ready);res.once('close',ready);});
    }res.end();
  }));
  router.get('/platform/settings',asyncRoute(async(req,res)=>res.json(await PlatformSettings.findById('platform'))));
  router.put('/platform/settings',asyncRoute(async(req,res)=>{
    const body=z.object({name:z.string().trim().min(1).max(60),supportEmail:z.string().trim().email().max(254).or(z.literal(''))}).strict().parse(req.body);
    await PlatformSettings.updateOne({_id:'platform'},{$set:body});res.json(body);
  }));
}
