import {join} from 'node:path';
import {writeFile,rename} from 'node:fs/promises';
import {context,onRefresh} from '../context.mjs';
import {emberAccounts,liveCodex,recentCodex,standaloneClaude} from './sources.mjs';

const accounts=new Map();
const file=join(context.directory,'plans.json');
let writes=Promise.resolve();
function publish(){
  const data=JSON.stringify({accounts:[...accounts.values()]});
  writes=writes.catch(()=>{}).then(async()=>{await writeFile(file+'.tmp',data);await rename(file+'.tmp',file);});
  return writes;
}
async function claude(){
  let found=[];
  try{found=emberAccounts();}catch{}
  if(!found.length)found=[await standaloneClaude()];
  for(const a of found){
    if(a.windows.length || !accounts.has(a.id))accounts.set(a.id,a);
  }
  for(const id of accounts.keys())if(id.startsWith('claude:')&&!found.some(a=>a.id===id))accounts.delete(id);
  await publish();
}
async function codex(){
  const cached=recentCodex();
  if(cached && (!accounts.get(cached.id)?.at || cached.at>accounts.get(cached.id).at)){
    accounts.set(cached.id,cached);await publish();
  }
  const live=await liveCodex();
  if(live)accounts.set(live.id,live);
  else if(!accounts.has('codex:local'))accounts.set('codex:local',{id:'codex:local',provider:'Codex',name:'Current account',source:'Codex app server',windows:[]});
  await publish();
}
let running=false,timer;
async function refresh(){
  if(running)return;
  running=true;clearTimeout(timer);
  try{await Promise.allSettled([claude(),codex()]);}
  finally{running=false;timer=setTimeout(refresh,60000);}
}
onRefresh(refresh);
refresh();
