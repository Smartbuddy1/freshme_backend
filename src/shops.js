import {z} from 'zod';
import {Shop,Settings} from './models.js';
import {asyncRoute,HttpError} from './utils.js';
import {database} from './database.js';
export const shopSlug=z.string().min(3).max(60).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/,'Use lowercase words separated by hyphens');
export const shopView=shop=>({id:shop._id,slug:shop.slug,name:shop.name,enabled:shop.enabled});
export async function resolveShopIdentifier(identifier,client=database()){
  if(typeof identifier!=='string'||identifier.length>80)return null;
  const {rows:[shop]}=await client.query('SELECT s.* FROM fresh_me.shops s JOIN fresh_me.shop_identifiers i ON i."shopId"=s._id WHERE i.identifier=$1',[identifier]);
  return shop||null;
}
export async function publicShop(slug,{allowDisabled=false}={}){
  const shop=slug?await resolveShopIdentifier(shopSlug.parse(slug)):await Shop.findById('shop');
  if(!shop||(!allowDisabled&&!shop.enabled))throw new HttpError(404,'Shop not found or unavailable');
  return shop;
}
export function superOnly(req,res,next){
  if(req.admin.role!=='SUPER_ADMIN')return next(new HttpError(403,'Super Admin access required'));
  next();
}
export const shopContext=asyncRoute(async(req,res,next)=>{
  const requested=req.get('x-shop-id');
  if(req.admin.role==='CLIENT_ADMIN'&&requested&&requested!==req.admin.shopId)throw new HttpError(403,'This shop is not assigned to your account');
  const id=req.admin.role==='SUPER_ADMIN'?requested:req.admin.shopId;
  if(!id||id.length>80)throw new HttpError(400,'Select a client shop');
  const shop=await Shop.findById(id);
  if(!shop)throw new HttpError(404,'Shop not found');
  if(!shop.enabled&&req.admin.role!=='SUPER_ADMIN')throw new HttpError(403,'Your shop is disabled. Contact the Super Admin.');
  req.shop=shop;req.shopId=shop._id;next();
});
export async function adminView(admin){
  const shop=admin.shopId?await Shop.findById(admin.shopId):null;
  return {email:admin.email,role:admin.role,shopId:admin.shopId,shop:shop?shopView(shop):null};
}
export const settingsFields='shopName tagline acceptingOrders receiptHeader receiptFooter prepCopy batchSize agentVersion agentLastSeenAt agentPrinterStatus battery';
export async function readShopSettings(id){
  const [settings,shop]=await Promise.all([Settings.findById(id).select(settingsFields),Shop.findById(id)]);
  return {...settings,shopId:shop.slug,shopSlug:shop.slug,enabled:shop.enabled};
}
