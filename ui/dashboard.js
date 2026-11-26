import {appendPage,assignWidget,pickWidget} from './page-actions.js';
import {importConnections} from './migration.js';
import {emberTile} from './ember.js';
import {mediaView,comfyView,storageView} from './services.js';
import {titles,layout,readPath} from './model.js';
import {ensure,state,current,activate,save,invoke,el,button,num,bytes} from './common.js';
const $=s=>document.querySelector(s);
let config=ensure(),page,tiles=[],timer,metrics={},sample=0;
const history=new Map(),feeds=new Map(),art=new Map();
function appendSeries(key,value){
  const a=history.get(key)||[];a.push(Number.isFinite(value)?value:null);
  if(a.length>90)a.shift();history.set(key,a);return a;
}
function chart(a,color,domain){
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('class','chart');svg.setAttribute('viewBox','0 0 240 70');svg.setAttribute('preserveAspectRatio','none');
  const peak=domain||Math.max(1,...a.filter(Number.isFinite)),path=document.createElementNS(svg.namespaceURI,'path');
  let restart=true,d='';a.forEach((v,i)=>{if(v==null){restart=true;return}d+=(restart?'M':'L')+(240*i/Math.max(1,a.length-1)).toFixed(1)+' '+(67-v/peak*63).toFixed(1)+' ';restart=false});
  path.setAttribute('d',d);path.setAttribute('fill','none');path.setAttribute('stroke',color);path.setAttribute('vector-effect','non-scaling-stroke');path.setAttribute('stroke-width','2');svg.append(path);return svg;
}
function fact(label,value){const f=el('div','fact');f.append(el('small','',label),el('b','',value));return f}
function facts(...items){const box=el('div','facts');box.append(...items);return box}
function bar(percent){const b=el('div','bar'),i=el('i');i.style.width=Math.max(0,Math.min(100,percent||0))+'%';b.append(i);return b}
function list(items){const l=el('div','list');for(const [a,b] of items){const r=el('div','line');r.append(el('b','',a),el('span','',b));l.append(r)}return l}
const value=t=>el('div','value',t),sub=t=>el('p','sub',t);
const accent={cpu:'#f4a874',gpu:'#c2ee83',memory:'#c6affe',disk:'#ffd084',network:'#8ad5dc',emby:'#94db88',comfy:'#f2ff59',spotify:'#69df90'};
function system(tile,s){
  const m=metrics,d=m.disks?.find(d=>d.mount===s.volume)||m.disks?.find(d=>d.mount==='/System/Volumes/Data')||m.disks?.find(d=>d.mount==='/')||m.disks?.[0];
  let n,t,items;
  switch(s.kind){
    case 'cpu':n=m.cpu;t=num(n)+'%';items=[fact('Logical cores',m.cores??'—'),fact('Recent peak',num(Math.max(0,...(history.get('cpu')||[])))+'%')];break;
    case 'gpu':n=m.gpu;t=n==null?'Unavailable':num(n)+'%';items=[fact('Graphics device',m.model||'—')];break;
    case 'memory':n=m.memory;t=bytes(n);items=[fact('Physical',bytes(m.capacity)),fact('Swap',bytes(m.swap))];break;
    case 'disk':n=d?.total?100*(d.total-d.free)/d.total:null;t=num(n)+'%';items=[fact('Available',bytes(d?.free)),fact('Volume',d?.name||'—')];break;
    case 'network':n=m.rx;t=bytes(n)+'/s';items=[fact('Upload',bytes(m.tx)+'/s'),fact('Interfaces','Ethernet + Wi-Fi')];break;
    default:return [value(m.host||'This Mac'),sub(m.model||'—'),facts(fact('Uptime',num(m.uptime/3600)+' h'),fact('Memory',bytes(m.capacity)))];
  }
  const key=s.kind==='disk'?'disk:'+d?.mount:s.kind;
  if(tile.lastSample!==sample&&!tile.seen.has(key)){appendSeries(key,n);tile.seen.add(key)}
  tile.lastSample=sample;
  const pct=s.kind==='memory'?100*n/m.capacity:n;
  const nodes=[value(t)];if(['gpu','cpu','disk','memory'].includes(s.kind))nodes.push(bar(pct));
  const domain=s.kind==='memory'?m.capacity:['cpu','gpu','disk'].includes(s.kind)?100:undefined;
  nodes.push(chart(history.get(key)||[],accent[s.kind],domain));
  if(s.kind==='network'){
    if(!tile.seen.has('tx')){appendSeries('tx',m.tx);tile.seen.add('tx')}
    nodes.push(chart(history.get('tx')||[],'#e9a27c'));
  }
  if(s.kind==='memory')items.push(fact('Wired',bytes(m.extra?.wired)),fact('Compressed',bytes(m.extra?.compressed)));
  nodes.push(facts(...items));return nodes;
}
function clockText(){return new Date().toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}
function focus(tile){
  const key='ew.focus',get=()=>JSON.parse(localStorage.getItem(key)||'{"left":1500,"end":0}');
  const f=get(),left=f.end?Math.max(0,Math.ceil((f.end-Date.now())/1000)):f.left;
  function put(o){localStorage.setItem(key,JSON.stringify(o));renderTile(tile)}
  const controls=el('div','controls');controls.append(button(f.end&&left?'Pause':'Start',()=>put(f.end&&left?{end:0,left}:{end:Date.now()+(left||1500)*1000,left:left||1500})),button('Reset',()=>put({end:0,left:1500})));
  return [value(Math.floor(left/60)+':'+String(left%60).padStart(2,'0')),sub('Focus session'),controls];
}
function shared(key,fetcher,seconds){
  let f=feeds.get(key);if(!f){f={next:0};feeds.set(key,f)}
  if(!f.loading&&Date.now()>=f.next){
    f.loading=true;f.next=Date.now()+seconds*1000;
    fetcher().then(d=>{f.data=d;f.error=null}).catch(e=>{f.error=String(e);f.data=null}).finally(()=>{f.loading=false;for(const t of tiles)if(t.feed===key)renderTile(t)});
  }return f;
}
function poster(address,id){
  if(!id)return '';
  const key=JSON.stringify([address,id]);if(art.has(key))return art.get(key);
  if(art.size>60)art.clear();
  art.set(key,'');invoke('poster',{address,mediaId:id}).then(url=>{art.set(key,url);for(const t of tiles)if(t.slot.kind==='emby')renderTile(t)}).catch(()=>{});return '';
}
function remote(tile,src,plugin){
  const kind=src.kind,key=JSON.stringify([src.id,src.kind,src.address]);tile.feed=key;
  const f=shared(key,()=>invoke('source_read',{kind,address:src.address}),kind==='comfy'?3:kind==='unraid'?15:6);
  if(!f.data)return [sub(f.error||'Connecting…')];
  const d=f.data;
  if(plugin)return customView(tile,plugin,d,src.name);
  if(kind==='emby')return mediaView(tile,d,src,poster,()=>renderTile(tile));
  if(kind==='comfy')return comfyView(tile,d,src);
  if(kind==='omlx')return [value(num(d.avg_generation_tps)+' tok/s'),sub('Average generation'),facts(fact('Active',d.active_requests??'—'),fact('Loaded models',d.models_loaded??'—'))];
  if(kind==='unraid')return storageView(d,{value,sub,bar,facts,fact,list});
  if(kind==='proxmox')return [value((d.data||[]).filter(r=>r.type==='node').length+' nodes'),list((d.data||[]).slice(0,40).map(r=>[r.name||r.id,r.status||r.type]))];
  return [sub('Choose a widget field in Studio')];
}
function customView(t,custom,data,label){
  const v=readPath(data,custom.field);
  if(custom.view==='list'){
    const rows=Array.isArray(v)?v.slice(0,24).map((item,i)=>[item?.name||item?.title||String(i+1),String(item?.value??item?.status??(typeof item==='object'?'':item))]):Object.entries(v&&typeof v==='object'?v:{}).slice(0,24).map(([k,x])=>[k,String(x)]);
    return [list(rows),sub(label)];
  }
  const out=[value((Number.isFinite(v)?num(v):String(v??'—'))+' '+custom.unit)];
  if(custom.view==='trend'){
    const key='custom:'+t.slot.id;if(t.customSample!==sample){appendSeries(key,v);t.customSample=sample}
    out.push(chart(history.get(key)||[],custom.accent));
  }
  return [...out,sub(label)];
}
function renderTile(t){
  const {slot:s,box}=t,kind=s.kind,custom=config.plugins.find(p=>p.id===kind);
  const title=titles[kind]||custom?.title||'Missing plugin';box.style.setProperty('--accent',custom?.accent||accent[kind]||'#c4f38f');
  if(kind==='notes'&&box.querySelector('textarea'))return;
  let nodes=[];
  if(['cpu','gpu','memory','disk','network','machine'].includes(kind))nodes=system(t,s);
  else if(kind==='clock')nodes=[value(clockText()),sub(new Date().toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'}))];
  else if(kind==='notes'){const a=el('textarea');a.value=localStorage.getItem('ew.notes')||'';a.placeholder='Write a note';a.oninput=()=>localStorage.setItem('ew.notes',a.value);nodes=[a]}
  else if(kind==='focus')nodes=focus(t);
  else if(kind==='spotify'){t.feed='spotify';const f=shared(t.feed,()=>invoke('spotify',{action:0}),4),d=f.data||{};const actions=el('div','controls');
    for(const [name,action] of [['Previous',3],[d.playing?'Pause':'Play',1],['Next',2]])actions.append(button(name,async()=>{try{f.data=await invoke('spotify',{action});renderTile(t)}catch(e){f.error=String(e);renderTile(t)}}));
    nodes=[value(d.title||'Spotify'),sub(f.error||d.artist||d.status||'Connecting…'),sub(d.album||''),actions]}
  else if(kind==='ember'){
    const root=emberTile(t);
    if(box.contains(root))return;
    nodes=[root];
  }
  else if(custom?.feed==='mac')nodes=customView(t,custom,metrics,'This Mac');
  else if(kind==='power'){const e=metrics.extra||{};nodes=[value(e.battery!=null?num(e.battery)+'%':e.thermal||'—'),sub(e.power||'Thermal state'),facts(fact('Thermal',e.thermal||'—'),fact('Power',e.charging?'Charging':e.power||'—'))]}
  else if(kind==='interfaces')nodes=[list((metrics.interfaces||[]).map(i=>[i.name,'↓ '+bytes(i.rx)+'/s  ↑ '+bytes(i.tx)+'/s']))];
  else if(kind==='volumes')nodes=[list((metrics.disks||[]).map(d=>[d.name,bytes(d.free)+' free']))];
  else if(kind==='world')nodes=[list([['Local',undefined],['Los Angeles','America/Los_Angeles'],['New York','America/New_York'],['London','Europe/London'],['Tokyo','Asia/Tokyo']].map(([label,timeZone])=>[label,new Date().toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',timeZone})]))];
  else if(kind==='empty'){
    if(box.querySelector('.add-widget'))return;
    const pageId=page.id;
    nodes=[button('+ Add widget',()=>pickWidget(state(),kind=>{
      const latest=state(),target=latest.pages.find(p=>p.id===pageId);
      const i=target?.slots.findIndex(item=>item.id===s.id)??-1;
      if(i>=0){target.slots[i]=assignWidget(latest,kind);save(latest)}
      mount();
    }),'add-widget')];
  }
  else {const src=config.sources.find(x=>x.id===s.source);nodes=src?remote(t,src,custom):[sub('Choose a connection in Layouts'),button('Settings',()=>invoke('open_settings'))]}
  const offsets=[box,...box.querySelectorAll('.list,.poster-grid')].map(n=>n.scrollTop);
  box.replaceChildren(el('h2','',title),...nodes);
  [box,...box.querySelectorAll('.list,.poster-grid')].forEach((n,i)=>{if(offsets[i])n.scrollTop=offsets[i]});
}
function mount(){
  config=state();page=current(config);$('#page').textContent=page.name;
  tiles=page.slots.map(slot=>({slot,box:el('article','tile'),seen:new Set()}));$('#tiles').replaceChildren(...tiles.map(t=>t.box));layout($('#tiles'),page.preset,page.regions);tiles.forEach(renderTile);
}
function switchPage(next){activate(next);mount();if($('#picker').open)$('#picker').close()}
$('#pages').onclick=()=>{const l=$('#page-list');l.replaceChildren(...config.pages.map(p=>button(p.name,()=>switchPage(p),page.id===p.id?'selected':'')));$('#picker').showModal()};
$('#add-page').onclick=()=>{const latest=state();const added=appendPage(latest);save(latest);switchPage(added)};
$('#dismiss').onclick=()=>$('#picker').close();$('#settings').onclick=()=>invoke('open_settings');
let down;window.addEventListener('edgetouch',({detail:d})=>{if(document.querySelector('dialog[open]')){down=undefined;return}if(d.kind==='down')down=d.x;if(d.kind==='up'&&down<=40&&d.x-down>70){switchPage(config.pages[(config.pages.findIndex(p=>p.id===page.id)+1)%config.pages.length])}});
window.addEventListener('storage',e=>{if(['edge-workbench.layout.v1','edge.current'].includes(e.key))mount()});
mount();
importConnections().then(result=>{if(result)mount()}).catch(()=>{});
async function tick(){
  if(!document.hidden){try{metrics=await invoke('read_metrics')||{}}catch{}sample++;const seen=new Set();for(const t of tiles){t.seen=seen;if(!t.box.querySelector('.edge-pressed')&&!t.box.matches(':active'))renderTile(t)}$('#time').textContent=clockText()}
  timer=setTimeout(tick,1000);
}tick();window.addEventListener('pagehide',()=>clearTimeout(timer));
