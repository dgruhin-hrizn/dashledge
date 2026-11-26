import {append,diskSampler} from './telemetry.mjs';
import {stat} from 'node:fs/promises';
import {readFile, writeFile, rename, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

import { context } from '../context.mjs';
const { directory, sources: [server] } = context;
const target = server.address.replace(/\/*$/, '/');
const host = new URL(target).hostname;
const select = (object, fields) => Object.fromEntries(fields.split(' ').filter(k=>object[k]!=null).map(k=>[k,object[k]]));
export const sources = {
  goliath: {
    system: ['system', 10, v=>select(v,'hostname version cpu_usage_percent ram_usage_percent cpu_temp_celsius uptime_seconds')],
    array: ['array', 15, v=>select(v,'state used_percent free_bytes total_bytes parity_valid parity_check_status parity_check_progress num_data_disks num_parity_disks')],
    network: ['network', 6, v=>{
      const nic=v.find(n=>n.ip_address===host) ?? v.find(n=>n.name==='br0');
      if (!nic) throw Error('LAN interface unavailable');
      return select(nic,'name rx_bytes_per_sec tx_bytes_per_sec errors_received errors_sent');
    }],
    disks: ['disks', 12, v=>v.map(d=>select(d,'name model mount_point device role status temperature_celsius smart_status smart_errors spin_state used_bytes free_bytes'))],
    docker: ['docker', 20, v=>v.filter(c=>c.state==='running').map(c=>select(c,'name image catalog_link state status cpu_percent memory_usage_bytes'))],
  },

};
export async function publish(kind,snapshot) {
  const dir=directory;
  await mkdir(dir,{recursive:true});
  const file=join(dir,'snapshot.js'), tmp=file+'.'+process.pid+'.tmp';
  await writeFile(tmp,'window.serverSnapshot?.('+JSON.stringify(snapshot)+');\n',{mode:0o600});
  await rename(tmp,file);
}
async function run(kind) {
  const key=server.key;
  const headers=key ? (kind==='goliath'?{Authorization:'Bearer '+key}:{'X-Emby-Token':key}) : {};
  const sections={}, due={}, history=[], trends={system:[],disk:[],docker:Object.create(null)}, sampleDisks=diskSampler();
  const icons=join(directory,'container-icons');
  await mkdir(icons,{recursive:true});
  const templates=JSON.parse(await readFile(new URL('./templates.json',import.meta.url),'utf8'));
  const checked=new Map();
  let updatingIcons=false;
  async function cacheIcons(rows){
    const eligible=rows.filter(c=>/^[a-z0-9][a-z0-9_.-]*$/i.test(c.name)&&!(checked.get(c.name)?.next>Date.now()));
    for(let i=0;i<eligible.length;i+=3)await Promise.all(eligible.slice(i,i+3).map(async c=>{
      const filename=c.name+'-icon.png',path=join(icons,filename);
      let available=false;
      try{
        const file=await stat(path).catch(()=>null);
        available=!!file;
        if(!file||Date.now()-file.mtimeMs>86400000){
          const native='http://'+host+'/state/plugins/dynamix.docker.manager/images/'+encodeURIComponent(filename);
          async function save(url){
            const res=await fetch(url,{signal:AbortSignal.timeout(5000),redirect:url===native?'error':'follow'});
            if(!res.ok||Number(res.headers.get('content-length'))>2000000)return false;
            const bytes=Buffer.from(await res.arrayBuffer());
            const image=bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a'||bytes.subarray(0,3).toString('hex')==='ffd8ff'||bytes.subarray(0,3).toString()==='GIF'||bytes.subarray(8,12).toString()==='WEBP';
            if(!image||bytes.length>2000000)return false;
            await writeFile(path+'.tmp',bytes);await rename(path+'.tmp',path);return true;
          }
          let loaded=await save(native).catch(()=>false);
          if(!loaded){
            const source=c.catalog_link||templates[c.image?.split('@')[0].replace(/:[^/:]+$/,'')];
            if(source?.startsWith('https://')){
              const res=await fetch(source,{signal:AbortSignal.timeout(5000)});
              if(res.ok){
                const icon=(await res.text()).match(/<Icon>\s*(.*?)\s*<\/Icon>/is)?.[1]?.trim().replaceAll('&amp;','&');
                if(icon?.startsWith('https://'))loaded=await save(icon).catch(()=>false);
              }
            }
          }
          available=loaded||available;
        }
      }catch{}
      checked.set(c.name,{available,next:Date.now()+(available?86400000:3600000)});
    }));
  }
  while(true) {
    const now=Date.now();
    const pending=Object.entries(sources[kind]).filter(([id])=>!(due[id]>now));
    await Promise.all(pending.map(async ([id,[path,interval,normalize]])=>{
      due[id]=now+interval*1000;
      try {
        if(kind==='emby' && !key) throw Error('API key needed');
        const r=await fetch(target+path,{headers,redirect:'error',signal:AbortSignal.timeout(4500)});
        if(!r.ok) throw Error([401,403].includes(r.status)?'Access denied':'HTTP '+r.status);
        const raw=await r.json(),value=normalize(raw);
        if(id==='disks')append(trends.disk,sampleDisks(raw),now,1800000);
        if(id==='system')append(trends.system,{at:now,cpu:value.cpu_usage_percent,mem:value.ram_usage_percent},now);
        if(id==='docker'){
          const running=new Set(value.map(c=>c.name));
          for(const name of Object.keys(trends.docker))if(!running.has(name))delete trends.docker[name];
          for(const c of value){
            append(trends.docker[c.name]??=[],{at:now,cpu:c.cpu_percent,mem:c.memory_usage_bytes},now);
            if(checked.get(c.name)?.available)c.icon='container-icons/'+c.name+'-icon.png';
          }
          if(!updatingIcons){updatingIcons=true;cacheIcons(value).finally(()=>{updatingIcons=false;});}
        }
        sections[id]={at:Date.now(),value};
        if(id==='network') history.push({at:now,rx:value.rx_bytes_per_sec,tx:value.tx_bytes_per_sec});
      } catch(e) {
        sections[id]={...sections[id],error:e.message==='fetch failed'?'Server unreachable':e.message};
        due[id]=now+Math.min(interval,30)*1000;
      }
    }));
    while(history.length && history[0].at<now-300000) history.shift();
    if(pending.length) await publish(kind,{kind,at:Date.now(),sections,history,trends});
    await delay(Math.max(250,Math.min(...Object.values(due))-Date.now()));
  }
}
await run('goliath');
