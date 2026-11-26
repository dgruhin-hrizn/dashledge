import {join} from 'node:path';
import {writeFile,rename} from 'node:fs/promises';
import {context,onCommand} from '../../_shared/context.mjs';
import {merge,nextCheck,profiles,readProfile} from './sources.mjs';

// Each account keeps its own schedule: readings every minute, sign-in problems every five,
// and failures back off. Check now in the placement's settings reads every account now.
const accounts=new Map(), due=new Map(), failures=new Map();
const file=join(context.directory,'snapshot.js');
let writes=Promise.resolve();
function publish(){
  // The view loads this with a <script>, which an opaque-origin frame may do; fetch it may not.
  const data='window.plansSample('+JSON.stringify({at:Date.now(),accounts:[...accounts.values()]})+');';
  writes=writes.catch(()=>{}).then(async()=>{await writeFile(file+'.tmp',data);await rename(file+'.tmp',file);});
  return writes;
}
async function readAccount(profile){
  const next=merge(accounts.get(profile.id),await readProfile(profile));
  const failed=['limited','error'].includes(next.state);
  failures.set(profile.id,failed?(failures.get(profile.id)||0)+1:0);
  due.set(profile.id,Date.now()+nextCheck(next,failures.get(profile.id)-1)*1000);
  // The profile may have been removed while it was being read.
  if(accounts.has(profile.id))accounts.set(profile.id,next);
  await publish();
}
let running=false,pending=false,timer;
async function refresh(force=false){
  if(running){pending||=force;return;}
  running=true;clearTimeout(timer);
  try{
    const current=profiles();
    for(const id of accounts.keys())if(!current.some(p=>p.id===id)){accounts.delete(id);due.delete(id);failures.delete(id);}
    let added=false;
    for(const p of current)if(!accounts.has(p.id)){accounts.set(p.id,{id:p.id,provider:p.provider,name:p.name,plan:null,windows:[],state:'checking'});added=true;}
    if(added)await publish();
    const now=Date.now(),ready=current.filter(p=>force||!(due.get(p.id)>now));
    // Providers run side by side; one provider's profiles run in turn so its CLI isn't flooded.
    await Promise.allSettled(['Claude','Codex'].map(async provider=>{
      for(const p of ready.filter(p=>p.provider===provider))await readAccount(p).catch(()=>{});
    }));
  }finally{
    running=false;
    if(pending){pending=false;refresh(true);}
    else timer=setTimeout(refresh,15000);
  }
}
onCommand('refresh',()=>refresh(true));
refresh(true);
