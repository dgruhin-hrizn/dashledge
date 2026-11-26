import {join} from 'node:path';
import {writeFile,rename} from 'node:fs/promises';
import {context,onRefresh} from '../../packages/_shared/context.mjs';
import {profiles,readProfile} from './sources.mjs';

const accounts=new Map();
const file=join(context.directory,'plans.json');
let writes=Promise.resolve();
function publish(){
  const data=JSON.stringify({accounts:[...accounts.values()]});
  writes=writes.catch(()=>{}).then(async()=>{await writeFile(file+'.tmp',data);await rename(file+'.tmp',file);});
  return writes;
}
async function refreshProvider(provider, profiles) {
  for (const profile of profiles.filter(p=>p.provider===provider)) {
    const next = await readProfile(profile);
    const last = accounts.get(profile.id);
    accounts.set(profile.id, next.unavailable && last?.at ? {...last,message:next.message} : next);
    await publish();
  }
}
let running=false,timer;
async function refresh(){
  if(running)return;
  running=true;clearTimeout(timer);
  try{
    const current = profiles();
    for (const id of accounts.keys()) if (!current.some(p=>p.id===id)) accounts.delete(id);
    await Promise.allSettled(['Claude','Codex'].map(provider=>refreshProvider(provider,current)));
  }
  finally{running=false;timer=setTimeout(refresh,60000);}
}
onRefresh(refresh);
refresh();
