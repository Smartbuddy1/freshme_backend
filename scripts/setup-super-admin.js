import bcrypt from 'bcryptjs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {connectDatabase,disconnectDatabase,transaction} from '../src/database.js';
import {readSeedConfig} from '../src/config.js';
import {migrate} from '../src/migrate.js';
import {Admin} from '../src/models.js';

export async function setupSuperAdmin(config){
  return transaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock(706318242)');
    const email=config.ADMIN_EMAIL.toLowerCase();
    const {rows:[existing]}=await client.query('SELECT * FROM fresh_me.admins WHERE email=$1 FOR UPDATE',[email]);
    if(existing?.disabled)throw new Error('The configured account is disabled. Choose an active primary admin account.');
    if(existing){
      if(existing.role!=='SUPER_ADMIN')await client.query('UPDATE fresh_me.admins SET role=\'SUPER_ADMIN\',"shopId"=NULL,"sessionVersion"="sessionVersion"+1 WHERE _id=$1',[existing._id]);
      return {created:false};
    }
    await Admin.create({email,passwordHash:await bcrypt.hash(config.ADMIN_PASSWORD,12),role:'SUPER_ADMIN',shopId:null},client);
    return {created:true};
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const config=readSeedConfig();await connectDatabase(config);await migrate();const result=await setupSuperAdmin(config);
    console.log(result.created?'Super Admin created from the configured ADMIN_EMAIL and ADMIN_PASSWORD.':'Configured account is now Super Admin. Its existing password was preserved.');
  }catch(e){console.error('Super Admin setup failed. Check configuration, migration status and whether the selected account is active.');process.exitCode=1;}
  finally{await disconnectDatabase();}
}
