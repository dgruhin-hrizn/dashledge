import {mountPlans} from './plan-monitor.js';
import {mountMarkets} from './markets.js';
import {mountPhotos,editPhotos} from './photos.js';
import {mountShortcuts,editShortcuts} from './mac-shortcuts.js';
import {renderSlack} from './slack.js';
import {slackWidgets} from './slack-catalog.js';
import {renderGoogle} from './google-desk.js';
import {renderAppleMusic} from './apple-music.js';
import {renderSpotify} from './spotify.js';
import {mountDmd} from './rundmd/player.js';
import {appendPage,assignWidget,pickWidget} from './page-actions.js';
import {general,loadGeneral,onGeneral} from './general.js';
import {instrumentKinds,renderInstrument} from './instruments.js';
import {mountOriginal,widgetSources} from './original-widgets.js';
import {titles,layout,readPath,originalKinds} from './model.js';
import {addBundledDmdPage,ensure,state,current,activate,save,invoke,el,button,num} from './common.js';
const $=s=>document.querySelector(s);
let config=ensure(),page,tiles=[],timer,metrics={},sample=0;
const history=new Map(),feeds=new Map();
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
function list(items){const l=el('div','list');for(const [a,b] of items){const r=el('div','line');r.append(el('b','',a),el('span','',b));l.append(r)}return l}
const value=t=>el('div','value',t),sub=t=>el('p','sub',t);
let prefs=general();
function clockText(timeZone){
  return new Date().toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',...(prefs.showSeconds?{second:'2-digit'}:{}),timeZone});
}
function focus(tile){
  const key='ew.focus',duration=prefs.focusMinutes*60;
  const f=JSON.parse(localStorage.getItem(key)||'null')||{left:duration,end:0};
  const left=f.end?Math.max(0,Math.ceil((f.end-Date.now())/1000)):f.left;
  function put(o){if(o)localStorage.setItem(key,JSON.stringify(o));else localStorage.removeItem(key);renderTile(tile)}
  const controls=el('div','controls');controls.append(button(f.end&&left?'Pause':'Start',()=>put(f.end&&left?{end:0,left}:{end:Date.now()+(left||duration)*1000,left:left||duration})),button('Reset',()=>put(null)));
  return [value(Math.floor(left/60)+':'+String(left%60).padStart(2,'0')),sub('Focus session'),controls];
}
function shared(key,fetcher,seconds){
  let f=feeds.get(key);if(!f){f={next:0};feeds.set(key,f)}
  if(!f.loading&&Date.now()>=f.next){
    f.loading=true;f.next=Date.now()+seconds*1000;
    fetcher().then(d=>{f.data=d;f.error=null}).catch(e=>{f.error=String(e)}).finally(()=>{f.loading=false;for(const t of tiles)if(t.feed===key)renderTile(t)});
  }return f;
}
function remote(tile,src,plugin){
  const key=JSON.stringify([src.id,src.kind,src.address]);tile.feed=key;
  const f=shared(key,()=>invoke('widget_source_read',{kind:src.kind,address:src.address}),6);
  if(f.data==null)return [sub(f.error||'Connecting…')];
  return plugin?customView(tile,plugin,f.data,f.error?src.name+' · last reading · '+f.error:src.name):[sub('No widget field configured')];
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
function saveSection(tile,kind,properties){
  const latest=state(),target=latest.pages.find(p=>p.id===tile.pageId);
  const i=target?.slots.findIndex(s=>s.id===tile.slot.id)??-1;
  if(i<0||JSON.stringify(target.slots[i])!==JSON.stringify(tile.slot))throw Error('This section changed. Close and select it again.');
  target.slots[i]={...assignWidget(latest,kind,tile.slot),...properties};
  save(latest);mount();
}
function renderTile(t){
  const {slot:s,box}=t,kind=s.kind,custom=config.plugins.find(p=>p.id===kind);
  const title=titles[kind]||custom?.title||'Missing plugin';box.style.setProperty('--accent',custom?.accent||'var(--highlight)');
  if(slackWidgets[kind]){renderSlack(box,s);return}
  if(kind==='applemusic'){renderAppleMusic(box);return}
  if(kind==='googledesk'){renderGoogle(box,s.id);return}
  if(kind==='plans'){t.dispose??=mountPlans(box,s);return}
  if(kind==='markets'){t.dispose??=mountMarkets(box,s,props=>saveSection(t,kind,props));return}
  if(kind==='photos'){t.dispose??=mountPhotos(box,s,photoDisplay=>saveSection(t,'photos',{photoDisplay}));return}
  if(kind==='shortcuts'){t.dispose??=mountShortcuts(box,s,items=>saveSection(t,'shortcuts',{shortcutPins:items}));return}
  if(kind==='spotify'){renderSpotify(box);return}
  if(kind==='rundmd'){t.dispose??=mountDmd(box);return}
  if(originalKinds.includes(kind)){t.dispose??=mountOriginal(box,s,config.sources);return}
  if(kind==='notes'&&box.querySelector('textarea'))return;
  let nodes=[];
  if(instrumentKinds.includes(kind)){box.classList.add('instrument');box.dataset.kind=kind;nodes=renderInstrument(kind,metrics,t)}
  else if(kind==='clock')nodes=[value(clockText()),sub(new Date().toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'}))];
  else if(kind==='notes'){const a=el('textarea');a.value=localStorage.getItem('ew.notes')||'';a.placeholder='Write a note';a.oninput=()=>localStorage.setItem('ew.notes',a.value);nodes=[a]}
  else if(kind==='focus')nodes=focus(t);
  else if(custom?.feed==='mac')nodes=customView(t,custom,metrics,'This Mac');
  else if(kind==='world')nodes=[list([['Local',undefined],['Los Angeles','America/Los_Angeles'],['New York','America/New_York'],['London','Europe/London'],['Tokyo','Asia/Tokyo']].map(([label,timeZone])=>[label,clockText(timeZone)]))];
  else if(kind==='empty'){
    if(box.querySelector('.add-widget'))return;
    const pageId=t.pageId;
    nodes=[button('+ Add widget',()=>pickWidget(state(),kind=>{
      if(kind==='photos'){editPhotos(null,photoDisplay=>saveSection(t,'photos',{photoDisplay}));return}
      if(kind==='shortcuts'){editShortcuts([],items=>saveSection(t,'shortcuts',{shortcutPins:items}),{touch:true,title:'Choose shortcuts'});return}
      const latest=state(),target=latest.pages.find(p=>p.id===pageId);
      const i=target?.slots.findIndex(item=>item.id===s.id)??-1;
      if(i>=0){target.slots[i]=assignWidget(latest,kind,target.slots[i]);save(latest)}
      mount();
    }),'add-widget')];
  }
  else {const src=config.sources.find(x=>x.id===s.source);nodes=src?remote(t,src,custom):[sub('Add a connection in Widget Studio'),button('Settings',()=>invoke('open_settings'))]}
  if(instrumentKinds.includes(kind)){
    nodes.forEach((node,i)=>{
      const current=box.children[i];
      if(!current)box.append(node);else if(current!==node)current.replaceWith(node);
    });
    while(box.children.length>nodes.length)box.lastElementChild.remove();
    return;
  }
  const offsets=[box,...box.querySelectorAll('.list')].map(n=>n.scrollTop);
  box.replaceChildren(...(instrumentKinds.includes(kind)?nodes:[el('h2','',title),...nodes]));
  [box,...box.querySelectorAll('.list')].forEach((n,i)=>{if(offsets[i])n.scrollTop=offsets[i]});
}
// Preserve original subviews, scroll positions and metric histories across page changes.
// Keeping the iframe in the document also avoids WebKit reloading it on reattachment.
const mountedPages=new Map();
function conceal(grid){
  for(const frame of grid?.querySelectorAll('iframe')||[]){
    const child=frame.contentWindow;
    if(child)child.dispatchEvent(new child.Event('blur'));
  }
}
function removePage(view){
  conceal(view.grid);
  for(const tile of view.tiles){tile.dispose?.();tile.readings?.forEach(reading=>reading.stop())}
  view.grid.remove();
}
function mount(){
  config=state();page=current(config);
  $('#tiles').setAttribute('aria-label',page.name);
  const soloKind=page.slots.length===1?page.slots[0].kind:null;
  document.body.classList.toggle('full-widget',['spotify','applemusic','googledesk','shortcuts','photos','markets','plans'].includes(soloKind)||!!slackWidgets[soloKind]||soloKind==='rundmd'||originalKinds.includes(soloKind));
  const frame=window.frameElement;
  if(frame){
    const music=['spotify','applemusic'].includes(soloKind),native=['applemusic','ember','googledesk','shortcuts','photos','markets','plans'].includes(soloKind)||!!slackWidgets[soloKind];
    if(frame.hasAttribute('data-full-spotify')!==music||frame.hasAttribute('data-native-viewport')!==native){
      frame.toggleAttribute('data-full-spotify',music);
      frame.toggleAttribute('data-native-viewport',native);
      frame.dispatchEvent(new Event('dashboardfit'));
    }
  }
  for(const [id,view] of mountedPages){
    if(!config.pages.some(p=>p.id===id)){removePage(view);mountedPages.delete(id)}
  }
  // Start the displayed page first, then warm the other configured dashboards.
  for(const p of [page,...config.pages.filter(p=>p.id!==page.id)]){
    let view=mountedPages.get(p.id);
    const signature=JSON.stringify([p.slots,p.slots.some(s=>s.kind==='plans'&&!s.planDisplay)?config.planDefaults:null,p.slots.map(s=>originalKinds.includes(s.kind)
      ?widgetSources(s.kind,s.source,config.sources)
      :[config.plugins.find(v=>v.id===s.kind),config.sources.find(v=>v.id===s.source)])]);
    if(view&&view.signature!==signature){removePage(view);view=null}
    if(!view){
      const grid=el('div','tile-grid');
      const instances=p.slots.map(slot=>({slot,pageId:p.id,box:el('article','tile')}));
      grid.hidden=p.id!==page.id;grid.append(...instances.map(t=>t.box));$('#tiles').append(grid);
      view={grid,tiles:instances,signature};mountedPages.set(p.id,view);
      for(const tile of instances)if(originalKinds.includes(tile.slot.kind)||config.plugins.some(v=>v.id===tile.slot.kind)||['spotify','applemusic'].includes(tile.slot.kind))renderTile(tile);
    }
    layout(view.grid,p.preset,p.regions,prefs.vertical);
    if(p.id===page.id){view.grid.hidden=false;tiles=view.tiles;tiles.forEach(renderTile)}
    else if(!view.grid.hidden){conceal(view.grid);view.grid.hidden=true}
  }
  const usedFeeds=new Set([...mountedPages.values()].flatMap(v=>v.tiles.map(t=>t.feed)));
  for(const key of feeds.keys())if(!usedFeeds.has(key))feeds.delete(key);
}
function switchPage(next){activate(next);mount();if($('#picker').open)$('#picker').close()}
function openPages(){if($('#picker').open)return;conceal(mountedPages.get(page.id)?.grid);const l=$('#page-list');l.replaceChildren(...config.pages.map(p=>button(p.name,()=>switchPage(p),page.id===p.id?'selected':'')));$('#picker').showModal()};
$('#add-page').onclick=()=>{const latest=state();const added=appendPage(latest);save(latest);switchPage(added)};
$('#widget-pages').onclick=openPages;
$('#picker-settings').onclick=()=>invoke('open_settings');
$('#dismiss').onclick=()=>$('#picker').close();
window.addEventListener('edgepageswipe',({detail:step})=>{
  if(document.querySelector('dialog[open]')||config.pages.length<2)return;
  const index=config.pages.findIndex(p=>p.id===page.id);
  switchPage(config.pages[(index+step+config.pages.length)%config.pages.length]);
});
window.addEventListener('edgepagepicker',openPages);
window.addEventListener('storage',e=>{if(['edge-workbench.layout.v1','edge.current'].includes(e.key))mount()});
function applyPreferences(settings){
  prefs=settings;
  document.body.style.setProperty('--primary',prefs.primary);
  document.body.style.setProperty('--highlight',prefs.accent);
  document.body.classList.toggle('vertical',prefs.vertical);
  mount();
}
onGeneral(applyPreferences);applyPreferences(prefs);
loadGeneral().catch(()=>{});
let nextMetrics=0;
async function tick(){
  if(!document.hidden){
    let fresh=false;
    if(Date.now()>=nextMetrics){
      nextMetrics=Date.now()+950;
      try{
        const next=await invoke('read_metrics');
        if(next&&(!sample||next.history?.at(-1)?.at!==metrics.history?.at(-1)?.at)){
          metrics=next;sample++;fresh=true;
        }
      }catch{}
    }
    for(const t of tiles){
      if(!fresh&&(instrumentKinds.includes(t.slot.kind)||config.plugins.some(p=>p.id===t.slot.kind&&p.feed==='mac')))continue;
      if(!t.box.querySelector('.edge-pressed')&&!t.box.matches(':active'))renderTile(t);
    }
    for(const view of mountedPages.values()){
      if(!view.grid.hidden)continue;
      for(const tile of view.tiles){
        const f=feeds.get(tile.feed);
        if((f&&!f.loading&&Date.now()>=f.next)||fresh&&config.plugins.some(v=>v.id===tile.slot.kind&&v.feed==='mac'&&v.view==='trend'))renderTile(tile);
      }
    }
  }
  timer=setTimeout(tick,1000);
}tick();window.addEventListener('blur',()=>conceal(mountedPages.get(page.id)?.grid));
window.addEventListener('pagehide',()=>{clearTimeout(timer);for(const view of mountedPages.values())removePage(view);mountedPages.clear()});

addBundledDmdPage().then(added=>{if(added)mount()});
