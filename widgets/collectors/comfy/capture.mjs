process.umask(0o077);
import {mkdirSync,writeFileSync,renameSync,unlinkSync,existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
const run=promisify(execFile);
import { context } from '../context.mjs';
const root = context.directory;
import { sample as sampleGPUs } from '../proxmox/gpu.mjs';
const configs = context.sources.map(s => ({ name: s.name, url: s.address, key: s.key, gpuGuest:s.gpuGuests?.worker }));
const thumbs=join(root,'previews');mkdirSync(thumbs,{recursive:true,mode:0o700});
const states=configs.map(({name,url})=>({name,host:new URL(url).host,status:'Connecting',active:null,pending:[],recent:[]}));
let timer;
function publish(){
  if(timer)return;
  timer=setTimeout(()=>{
    timer=null;
    const file=join(root,'snapshot.js'),tmp=file+'.'+process.pid+'.tmp';
    writeFileSync(tmp,'window.comfySnapshot?.('+JSON.stringify({at:Date.now(),workers:states})+');',{mode:0o600});
    renameSync(tmp,file);
  },200);
}
function job(tuple){
  const graph=tuple[2]||{};
  return {id:String(tuple[1]),steps:Object.keys(graph).length,nodes:Object.fromEntries(Object.entries(graph).map(([id,n])=>[id,String(n?.class_type||'Node')]))};
}
async function request(url,key){const r=await fetch(url,{headers:key ? {Authorization:'Bearer '+key} : {},redirect:'error',signal:AbortSignal.timeout(4000)});if(!r.ok)throw Error('HTTP '+r.status);return r.json();}
async function worker(config,index){
  const state=states[index],base=new URL(config.url);if(!['http:','https:'].includes(base.protocol))throw Error('Invalid worker URL');
  base.pathname=base.pathname.replace(/\/*$/,'/');
  let ws,nodes={},nextStats=0,nextHistory=0,lastJob,failures=0,nextImage=0;
  let streamAt = 0;
  function recordGPU(values){
    const loads=values.filter(v=>Number.isFinite(v) && v>=0 && v<=100);
    if(!loads.length)return false;
    state.gpuLoad={percent:Math.max(...loads),at:Date.now()};
    publish();return true;
  }
  async function pollGuest(mapping){
    const target=typeof mapping==='string'?mapping:mapping?.target;
    if(typeof target!=='string'||target.split('@').pop().toLowerCase()!==base.hostname.toLowerCase())return;
    while(true){
      if(Date.now()-streamAt>15000 && state.status!=='Offline'){
        try{
          const devices=await sampleGPUs(target,mapping.identityFile);
          if(Date.now()-streamAt>15000 && state.status!=='Offline')recordGPU(devices.map(d=>d.load));
        }catch{/* Optional telemetry expires independently of the queue. */}
      }
      await delay(5000);
    }
  }
  if(config.gpuGuest)void pollGuest(config.gpuGuest);
  function socket(){
    if(ws)return;
    const u=new URL('ws',base);u.protocol=base.protocol==='https:'?'wss:':'ws:';
    const socket=new WebSocket(u, {headers:config.key ? {Authorization:'Bearer '+config.key} : {}});ws=socket;
    socket.onclose=()=>{if(ws===socket)ws=null;};
    socket.onerror=()=>socket.close();
    socket.onmessage=e=>{
      if(typeof e.data!=='string')return;
      let msg;try{msg=JSON.parse(e.data);}catch{return;}
      const d=msg.data;
      if(msg.type==='crystools.monitor' && Array.isArray(d?.gpus)){
        if(state.status!=='Offline' && recordGPU(d.gpus.map(g=>g?.gpu_utilization)))streamAt=Date.now();
        return;
      }
      if(!d||!state.active||state.active.id!==String(d.prompt_id))return;
      if(msg.type==='executing' && d.node!=null){
        state.active.node=nodes[d.node]||'Node '+d.node;state.active.progress=null;publish();
      }else if(msg.type==='progress'&&Number.isFinite(d.value)&&d.max>0){
        if(d.node!=null)state.active.node=nodes[d.node]||'Node '+d.node;
        state.active.progress=[d.value,d.max];publish();
      }
    };
  }
  async function updateHistory(now){
    const history=await request(new URL('history?max_items=8',base),config.key);
    const items=Object.entries(history).sort((a,b)=>(b[1].prompt?.[0]||0)-(a[1].prompt?.[0]||0));
    state.recent=items.slice(0,5).map(([id,h])=>({id,status:h.status?.status_str||'Recorded'}));
    let image,id;
    for(const [key,h] of items){
      image=Object.values(h.outputs||{}).flatMap(o=>Array.isArray(o.images)?o.images:[]).find(i=>i.type==='output'&&i.filename);
      if(image){id=key;break;}
    }
    if(!image){delete state.preview;return;}
    const token=createHash('sha256').update(JSON.stringify([base.host,id,image.filename,image.subfolder])).digest('hex').slice(0,20);
    const filename=index+'-'+token+'.jpg',dest=join(thumbs,filename);
    if(state.preview!==filename)delete state.preview;
    if(!existsSync(dest)){
      if(now<nextImage)return;
      nextImage=now+15000;
      const url=new URL('view',base);url.search=new URLSearchParams({filename:image.filename,subfolder:image.subfolder||'',type:'output',preview:'jpeg;75'});
      const response=await fetch(url,{headers:config.key ? {Authorization:'Bearer '+config.key} : {},redirect:'error',signal:AbortSignal.timeout(8000)});
      if(!response.ok||Number(response.headers.get('content-length'))>16000000){await response.body?.cancel();return;}
      const chunks=[];let size=0;
      for await(const chunk of response.body){size+=chunk.length;if(size>16000000)return;chunks.push(chunk);}
      const tmp=dest+'.'+process.pid+'.tmp',out=tmp+'.jpg';
      try{
        writeFileSync(tmp,Buffer.concat(chunks),{mode:0o600});
        await run('/usr/bin/sips',['-Z','480','-s','format','jpeg',tmp,'--out',out],{timeout:5000});
        renameSync(out,dest);
      }finally{for(const f of [tmp,out])if(existsSync(f))unlinkSync(f);}
    }
    state.preview=filename;
    for(const f of readdirSync(thumbs))if(f.startsWith(index+'-')&&f!==filename&&/^[01]-[a-f0-9]{20}\.jpg$/.test(f))unlinkSync(join(thumbs,f));
  }
  while(true){
    const now=Date.now();
    try{
      const q=await request(new URL('queue',base),config.key);
      if(!Array.isArray(q.queue_running)||!Array.isArray(q.queue_pending))throw Error('Invalid queue');
      const j=q.queue_running.length?job(q.queue_running[0]):null;
      if(j?.id!==lastJob){nextHistory=0;nodes=j?.nodes||{};state.active=j?{id:j.id,steps:j.steps}:null;lastJob=j?.id;}
      state.pending=q.queue_pending.slice(0,20).map(t=>({id:String(t[1]),steps:Object.keys(t[2]||{}).length}));
      state.queued=q.queue_pending.length;state.at=Date.now();state.status=j?'Rendering':'Idle';failures=0;publish();socket();
      await Promise.all([
        now<nextStats?null:(async()=>{nextStats=now+30000;try{
          const stats=await request(new URL('system_stats',base),config.key);const system=stats.system||{};
          state.hardware={ram:system.ram_total,ramFree:system.ram_free,torch:system.pytorch_version};
          state.devices=(stats.devices||[]).map(d=>({name:d.name,type:d.type,index:d.index,total:d.vram_total,free:d.vram_free}));
        }catch{delete state.devices;delete state.hardware;}})(),
        now<nextHistory?null:(async()=>{nextHistory=now+30000;try{await updateHistory(now);}catch{/* Queue remains usable if history or an image is unavailable. */}})()
      ]);
    }catch(e){
      delete state.gpuLoad;streamAt=0;state.status='Offline';state.error=e.message==='fetch failed'?'Unreachable':e.message;
      state.active=null;lastJob=undefined;state.pending=[];delete state.queued;delete state.devices;delete state.hardware;delete state.preview;nextStats=nextHistory=0;ws?.close();failures++;
    }
    if(state.status!=='Offline')delete state.error;publish();
    await delay(failures?Math.min(30000,5000*failures):state.active?3000:8000);
  }
}
publish();await Promise.all(configs.map(worker));
