import {el,button,num,bytes,invoke} from './common.js';

function section(tag,cls,text){return el(tag,cls,text)}
function openDetails(title,items,seconds){
  const dlg=el('dialog','details');let timeout;
  const close=button('Close',()=>dlg.close());
  dlg.append(el('h2','',title),...items,close);document.body.append(dlg);
  const reset=()=>{clearTimeout(timeout);if(seconds)timeout=setTimeout(()=>dlg.close(),seconds*1000)};
  dlg.addEventListener('pointerdown',reset);dlg.onclose=()=>{clearTimeout(timeout);dlg.remove()};dlg.showModal();reset();return dlg;
}
function time(ticks){if(!Number.isFinite(ticks))return '—';const s=Math.floor(ticks/1e7);return Math.floor(s/3600)?[Math.floor(s/3600),String(Math.floor(s/60)%60).padStart(2,'0'),String(s%60).padStart(2,'0')].join(':'):[Math.floor(s/60),String(s%60).padStart(2,'0')].join(':')}
function brief(...items){return items.filter(x=>x!=null&&x!=='').join(' · ')}
function progress(v){const b=el('progress');b.max=100;b.value=Math.max(0,Math.min(100,v||0));return b}
export function mediaView(tile,d,src,poster,redraw){
  const rows=d.sessions||[],count=rows.length;
  if(!count)return [el('div','value','Cinema quiet'),el('p','sub','No active streams')];
  const stride=3,now=Date.now();
  tile.offset=(tile.offset||0)%count;
  if(count>stride&&!tile.inspect&&now>=(tile.rotateAt||Infinity)){tile.offset=(tile.offset+1)%count;tile.rotateAt=now+6000}
  if(!tile.rotateAt)tile.rotateAt=now+6000;
  function advance(n){tile.offset=(tile.offset+n+count)%count;tile.rotateAt=Date.now()+6000;redraw()}
  const controls=el('div','media-head'),grid=el('div','reel');
  controls.append(el('b','',count+' '+(count===1?'stream':'streams')));
  if(count>stride)controls.append(button('‹',()=>advance(-1)),button('›',()=>advance(1)));
  for(let i=0;i<Math.min(count,stride);i++){
    const s=rows[(tile.offset+i)%count],url=poster(src.address,s.mediaId);
    const art=el('img');if(url)art.src=url;art.alt='';
    const meta=el('div','reel-meta');meta.append(el('small','',s.paused?'Ⅱ  PAUSED':'▶  PLAYING'),el('strong','',s.title),el('span','',brief(s.user,s.device)),progress(100*s.position/s.duration));
    const card=button('',()=>{tile.inspect=true;
      const dlg=openDetails(s.title,[el('p','',brief(s.series,s.year,s.client,s.method)),el('p','',brief(s.user,s.device,time(s.position)+' / '+time(s.duration))),el('p','',s.overview||''),el('p','',brief(s.rating!=null?'Audience '+s.rating+'/10':'',s.critics!=null?'Critics '+s.critics+'%':''))],15);
      dlg.addEventListener('close',()=>{tile.inspect=false;tile.rotateAt=Date.now()+6000;redraw()});
    },'reel-card');card.append(art,meta);grid.append(card);
  }
  return [controls,grid];
}
export function comfyView(tile,d,src){
  const title=el('div','value',d.running?'Rendering':'Ready'),gpu=el('div','devices');
  for(const g of d.devices||[]){const model=String(g.name||'GPU').replace(/^cuda:\d+\s*/i,'').split(' : ')[0];gpu.append(el('b','',model),progress(100*(g.vram_total-g.vram_free)/g.vram_total),el('small','',bytes(g.vram_total-g.vram_free)+' / '+bytes(g.vram_total)+' VRAM'))}
  const preview=button('Reveal latest output',async()=>{
    const msg=el('p','sub','Loading output…'),dlg=openDetails('Latest output',[msg],15);
    try{const uri=await invoke('comfy_preview',{address:src.address});if(dlg.open){const img=el('img','private-image');img.alt='Latest generated output';img.src=uri;msg.replaceWith(img)}}catch(e){msg.textContent=String(e)}
  });
  return [title,el('p','sub',d.running+' running · '+d.queued+' queued'),gpu,preview];
}
export function storageView(d,tools){
  const {value,sub,bar,facts,fact,list}=tools, disks=Array.isArray(d.disks)?d.disks:[],running=d.running;
  const rank=x=>/parity/i.test(x.role||x.name)?0:/data|array/i.test(x.role)||/^disk\d+/i.test(x.name)?1:2;
  const ordered=[...disks].sort((a,b)=>rank(a)-rank(b)||String(a.name).localeCompare(String(b.name),undefined,{numeric:true}));
  const alerts=ordered.filter(x=>/fail|error|fault/i.test(x.smart_status||'')||Number(x.smart_errors)>0);
  const r=el('div','controls');
  r.append(button('Disks · '+(Array.isArray(d.disks)?disks.length:'—'),()=>openDetails('Disk inventory',[list(ordered.map(x=>[brief(x.name,x.model),brief(x.role,x.smart_status,x.temperature_celsius!=null?x.temperature_celsius+'°C':'')]))])),
    button('Docker · '+(running?.length??'—'),()=>openDetails('Running containers',[list((running||[]).map(c=>[c.name,num(c.cpu)+'% CPU']))])));
  return [value(bytes(d.array?.free_bytes)),sub('Array free · '+(d.array?.state||'—')),bar(d.array?.used_percent),facts(fact('Parity',d.array?.parity_valid===true?'Valid':d.array?.parity_valid===false?'Check':'—'),fact('Disk health',alerts.length?alerts.map(x=>x.name).join(', '):Array.isArray(d.disks)?'Clear':'Unavailable')),r];
}
