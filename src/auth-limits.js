import {createHash} from 'node:crypto';
import rateLimit from 'express-rate-limit';

const message={error:'Too many attempts. Please wait before trying again.'};
const common={standardHeaders:'draft-7',legacyHeaders:false,message};

export function accountLoginLimit() {
  return rateLimit({...common,windowMs:15*60000,limit:20,skipSuccessfulRequests:true,
    keyGenerator:req=>createHash('sha256').update(
      typeof req.body?.email==='string'?req.body.email.trim().toLowerCase():'invalid-login'
    ).digest('hex')});
}

export function passwordChangeLimit() {
  return rateLimit({...common,windowMs:15*60000,limit:10,skipSuccessfulRequests:true,
    keyGenerator:req=>String(req.admin._id)});
}
