import {general,loadGeneral,updateGeneral,fitDashboard,checkUpdate,automaticUpdates} from './general.js';
import {icon} from './admin-icons.js';
import {appendPage,assignWidget,pickWidget} from './page-actions.js';
import {importConnections,lastImport} from './migration.js';
import {presets,titles,id,resize,split,layout,plugin,readPath} from './model.js';
import {ensure,state,current,activate,save,invoke,el,button,field,select} from './common.js';
let config=ensure(),tab='General',chosen=current(config).id,index=0,undo=[],statusTimer;
const main=document.querySelector('#editor');
const links=[['General','General','general'],['Layouts','Pages & layouts','pages'],['Connections','Connections','connections'],['Widget Studio','Widget Studio','studio'],['Preview','Live preview','preview']];
const sourcesStatus=new Map();
function decorated(label,action,symbol,cls=''){const b=button(label,action,cls);b.prepend(icon(symbol));return b}
function heading(text,actions){const h=el('header','admin-heading');h.append(el('h1','',text));if(actions)h.append(actions);return h}
function tag(kind){const t=el('span','kind-icon');t.dataset.kind=kind;t.append(icon(kind));return t}
function panel(title,...children){const p=section(title,...children);p.classList.add('panel');return p}
function go(next){tab=next;render()}
document.querySelector('#brand-icon').append(icon('brand'));
const sourceNames={comfy:'ComfyUI',emby:'Emby',proxmox:'Proxmox',omlx:'oMLX',unraid:'Unraid',json:'JSON endpoint'};
function notice(text){const n=document.querySelector('#notice');n.textContent=text;clearTimeout(statusTimer);statusTimer=setTimeout(()=>n.textContent='',6000)}
function input(value='',type='text'){const n=el('input');n.type=type;n.value=value;return n}
function section(title,...children){const s=el('section');s.append(el('h2','',title),...children);return s}
function row(...children){const r=el('div','row');r.append(...children);return r}
function page(){return config.pages.find(p=>p.id===chosen)||config.pages[0]}
function change(fn){const before=JSON.stringify(config);try{fn();save(config);undo.push(before);if(undo.length>30)undo.shift();render()}catch(e){config=JSON.parse(before);notice(e.message||String(e))}}
function formDialog(title,fields,apply,submitLabel='Save'){
  const d=el('dialog','admin-dialog'),f=el('form','fields'),error=el('p','form-error');
  d.setAttribute('aria-label',title);error.setAttribute('role','alert');
  const ok=el('button','primary',submitLabel),actions=row(button('Cancel',()=>d.close()),ok);
  actions.classList.add('form-actions');f.append(el('h2','',title),...fields,error,actions);
  d.append(f);document.body.append(d);d.onclose=()=>d.remove();
  f.onsubmit=async e=>{e.preventDefault();ok.disabled=true;try{await apply();d.close()}catch(e){error.textContent=e.message||String(e)}finally{ok.disabled=false}};
  d.showModal();
}
function nameDialog(title,value,cb){const n=input(value);n.required=true;n.maxLength=60;formDialog(title,[field('Name',n)],()=>{if(!n.value.trim())throw Error('Enter a name');cb(n.value.trim())})}
function pageControls(p){
  const move=delta=>change(()=>{let i=config.pages.indexOf(p),j=i+delta;if(j>=0&&j<config.pages.length)[config.pages[i],config.pages[j]]=[config.pages[j],config.pages[i]]});
  const options=el('details','page-options');
  options.append(el('summary','','Page options'));
  options.append(row(
    button('Rename',()=>nameDialog('Rename page',p.name,name=>change(()=>p.name=name))),
    button('Move left',()=>move(-1)),button('Move right',()=>move(1)),
    button('Delete',()=>{if(config.pages.length===1)return notice('Keep at least one page.');formDialog('Delete '+p.name+'?',[el('p','sub','Undo can restore this page.')],()=>change(()=>{config.pages.splice(config.pages.indexOf(p),1);chosen=config.pages[0].id;index=0;activate(page())}))}),
    ));
  const undoButton=decorated('Undo',()=>{config=JSON.parse(undo.pop());save(config);chosen=page().id;index=0;activate(page());render()},'undo');
  undoButton.disabled=!undo.length;
  return row(options,undoButton);
}
function layouts(){
  const p=page();index=Math.min(index,p.slots.length-1);
  const pages=el('div','page-tabs'),strip=el('div','page-strip');
  strip.setAttribute('role','group');strip.setAttribute('aria-label','Pages');
  for(const item of config.pages){
    const active=item.id===p.id;
    const tab=button(item.name,()=>{chosen=item.id;index=0;activate(item);render()},active?'selected':'');
    if(active)tab.setAttribute('aria-current','page');
    pages.append(tab);
  }
  const add=button('+ Add page',()=>change(()=>{const next=appendPage(config);chosen=next.id;index=0;activate(next)}),'primary');
  strip.append(pages,add);
  const canvas=el('div','canvas');
  const assign=(i,kind)=>change(()=>{p.slots[i]=assignWidget(config,kind);index=i});
  p.slots.forEach((s,i)=>{
    const empty=s.kind==='empty';
    const name=empty?'+ Add widget':titles[s.kind]||config.plugins.find(x=>x.id===s.kind)?.title||'Missing plugin';
    const b=button(name,()=>{
      index=i;render();
      if(empty)pickWidget(config,kind=>assign(i,kind));
    },[i===index?'selected':'',empty?'empty-slot':''].join(' '));
    b.prepend(icon(empty?'plus':s.kind));
    b.setAttribute('aria-pressed',String(i===index));
    b.ondragover=e=>e.preventDefault();
    b.ondrop=e=>{e.preventDefault();const k=e.dataTransfer.getData('text/plain');if(Object.hasOwn(titles,k)||config.plugins.some(x=>x.id===k))assign(i,k)};
    canvas.append(b);
  });
  const vertical=general().vertical;canvas.classList.toggle('portrait',vertical);
  layout(canvas,p.preset,p.regions,vertical);
  const presetGrid=el('div','preset-grid');
  for(const key of Object.keys(presets)){
    const visual=el('span','preset-diagram');visual.setAttribute('aria-hidden','true');
    const cells=presets[key].reduce((a,b)=>a+b,0);
    for(let n=0;n<cells;n++)visual.append(el('i'));
    layout(visual,key,undefined,vertical);
    const control=button(key,()=>change(()=>resize(p,key)),p.preset===key&&!p.regions?'selected':'');
    control.prepend(visual);control.setAttribute('aria-pressed',String(p.preset===key&&!p.regions));presetGrid.append(control);
  }
  const work=el('div','layout-work'),left=el('div','layout-stage'),screen=el('section','panel editor-stage');
  const bar=row(el('h2','',p.name),pageControls(p));bar.classList.add('layout-tools');
  const footer=row(el('small','','XENEON EDGE'),el('small','',p.slots.length+' '+(p.slots.length===1?'section':'sections')));
  footer.classList.add('stage-caption');screen.append(bar,canvas,footer);
  const s=p.slots[index],feed=config.plugins.find(x=>x.id===s.kind)?.feed||s.kind;
  const inspector=panel('Section '+(index+1)),inspectorTitle=row(tag(s.kind),el('strong','',titles[s.kind]||config.plugins.find(v=>v.id===s.kind)?.title||'Missing widget'));
  inspectorTitle.classList.add('inspector-title');inspector.append(inspectorTitle);
  if(Object.hasOwn(sourceNames,feed)){
    const matching=config.sources.filter(x=>x.kind===feed);
    inspector.append(field('Connection',select([['','Choose connection'],...matching.map(x=>[x.id,x.name])],s.source,x=>change(()=>s.source=x))),button('Manage connections',()=>go('Connections')));
  }
  if(s.kind==='disk'){
    const choice=select([['','Startup volume']],s.volume,x=>change(()=>s.volume=x));inspector.append(field('Volume',choice));
    invoke('read_metrics').then(m=>{for(const d of m?.disks||[])choice.add(new Option(d.mount,d.mount));choice.value=s.volume}).catch(()=>{});
  }
  const edits=row(decorated('Split',()=>change(()=>split(p,index,vertical?'row':'column')),'split'),decorated('Stack',()=>change(()=>split(p,index,vertical?'column':'row')),'stack'));
  if(s.kind!=='empty')edits.append(button('Clear section',()=>assign(index,'empty'),'quiet'));
  inspector.append(edits);
  left.append(screen,panel('Layout preset',presetGrid),inspector);
  const lib=el('div','library-list'),search=input();search.type='search';search.placeholder='Find a widget';search.setAttribute('aria-label','Find a widget');
  const searchBox=el('div','search-box');searchBox.append(icon('find'),search);
  const groups=[
    ['Mac system',['cpu','gpu','memory','disk','network','power','interfaces','volumes','machine']],
    ['Services',['ember','omlx','comfy','proxmox','unraid','emby','spotify']],
    ['Everyday',['clock','world','focus','notes']],
    ['My widgets',config.plugins.map(v=>v.id)]
  ];
  const fill=()=>{
    lib.replaceChildren();
    const query=search.value.trim().toLowerCase();
    for(const [group,kinds] of groups){
      const rows=[];
      for(const k of kinds){
        const label=titles[k]||config.plugins.find(v=>v.id===k)?.title;if(!label?.toLowerCase().includes(query))continue;
        const b=button('',()=>assign(index,k),s.kind===k?'selected':'');
        b.append(tag(k),el('span','',label),icon(s.kind===k?'check':'plus'));
        b.setAttribute('aria-label','Place '+label+' in section '+(index+1));b.draggable=true;b.ondragstart=e=>e.dataTransfer.setData('text/plain',k);rows.push(b);
      }
      if(rows.length)lib.append(el('h3','group-title',group),...rows);
    }
    if(!lib.childElementCount)lib.append(el('p','sub','No matching widgets'));
  };
  search.oninput=fill;fill();
  const library=panel('Widget library',searchBox,lib);library.classList.add('library');
  work.append(left,library);main.append(strip,work);
  pages.querySelector('[aria-current]')?.scrollIntoView?.({block:'nearest',inline:'nearest'});
}
const sourceHelp={
  comfy:['Worker URL','http://worker.local:8188','Optional bearer token'],
  emby:['Server URL','http://media.local:8096/emby/','Emby API key'],
  proxmox:['Cluster URL','https://pve.local:8006','API token ID=secret'],
  omlx:['Server URL','http://localhost:8000','oMLX API key'],
  unraid:['Monitoring API URL','http://tower.local:8043/api/v1/','Monitoring API token'],
  json:['JSON endpoint','https://service.example/status','Optional bearer token']
};
function sourceForm(existing){
  const kind=select(Object.entries(sourceNames),existing?.kind||'comfy',()=>{}),name=input(existing?.name),address=input(existing?.address,'url'),secret=input('','password');
  name.required=address.required=true;secret.autocomplete='new-password';secret.placeholder=existing?'Leave blank to keep saved credential':'Optional';
  const addressField=field('',address),secretField=field('',secret);
  const describe=()=>{const [label,hint,credential]=sourceHelp[kind.value];addressField.firstChild.textContent=label;address.placeholder=hint;secretField.firstChild.textContent=credential};
  kind.onchange=describe;describe();
  formDialog(existing?'Edit connection':'Add connection',[field('Service',kind),field('Connection name',name),addressField,secretField],async()=>{
    const u=new URL(address.value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error('Use an HTTP(S) URL without embedded credentials or query');
    const obj={id:existing?.id||id(),name:name.value.trim(),kind:kind.value,address:u.href};
    if(existing?.gpuGuests&&existing.kind===obj.kind&&existing.address===obj.address)obj.gpuGuests=existing.gpuGuests;
    if(!obj.name)throw Error('Enter a connection name');
    if(secret.value)await invoke('set_secret',{kind:obj.kind,address:obj.address,secret:secret.value});
    change(()=>{if(existing)config.sources[config.sources.findIndex(item=>item.id===existing.id)]=obj;else config.sources.push(obj)});
  })
}
function connections(){
  const migrate=button('Import from Zurface',async()=>{
    migrate.disabled=true;migrate.textContent='Importing…';
    try{await importConnections(true);config=state();undo=[];render()}catch(e){notice(String(e))}finally{migrate.disabled=false}
  });
  main.append(heading('Connections',row(migrate,decorated('Add connection',()=>sourceForm(),'plus','primary'))));
  const sources=el('section','panel service-panel');
  sources.append(row(el('h2','','Saved connections'),button('Unlock connections',async()=>{
    try{await invoke('unlock_connections');notice('Connections unlocked')}catch(e){notice(String(e))}
  })));
  const report=lastImport();
  if(report){
    sources.append(el('p','sub',report.found+' found in Zurface'+(report.ember?' · Ember uses its local database':'')));
    for(const issue of report.issues)sources.append(el('p','import-issue',issue));
  }
  if(!config.sources.length)sources.append(el('p','empty-info','Import your Zurface connections or add a server to get started.'));
  for(const s of config.sources){
    const line=el('div','service-row'),details=el('div','service-identity'),health=el('small','service-health'),actions=el('div','service-actions');
    const endpointKey=s.kind+'|'+s.address;health.textContent=sourcesStatus.get(endpointKey)||'';
    details.append(el('strong','',s.name),el('code','endpoint',s.address));
    if(s.gpuGuests)details.append(el('small','',Object.keys(s.gpuGuests).length+' saved guest SSH mappings'));
    const test=button('Test',async()=>{
      test.disabled=true;health.textContent='Testing…';
      try{await invoke('source_read',{kind:s.kind,address:s.address});health.textContent='Connected'}
      catch(e){health.textContent=String(e)}finally{sourcesStatus.set(endpointKey,health.textContent);test.disabled=false}
    });
    const menu=el('details','service-menu'),summary=el('summary','','•••');
    summary.setAttribute('aria-label','Options for '+s.name);
    const recover=button('Recover previous credential',async()=>{
      try{await invoke('recover_credential',{kind:s.kind,address:s.address});notice('Previous credential recovered')}catch(e){notice(String(e))}
      menu.open=false;
    });
    menu.append(summary,row(button('Edit',()=>sourceForm(s)),recover,button('Remove',()=>formDialog('Remove '+s.name+'?',[el('p','','Widgets using this connection can be reconnected in Pages & layouts.')],async()=>{
      if(!config.sources.some(other=>other.id!==s.id&&other.kind===s.kind&&((other.kind==='json'?other.address:other.address.replace(/\/+$/,''))===(s.kind==='json'?s.address:s.address.replace(/\/+$/,'')))))await invoke('set_secret',{kind:s.kind,address:s.address,secret:''});
      change(()=>{config.sources=config.sources.filter(x=>x.id!==s.id);for(const p of config.pages)for(const w of p.slots)if(w.source===s.id)w.source=''});
    },'Remove'))));
    actions.append(test,menu);details.append(health);line.append(tag(s.kind),details,el('small','service-type',sourceNames[s.kind]),actions);sources.append(line);
  }
  main.append(sources);
}
function download(obj){
  const a=el('a'),url=URL.createObjectURL(new Blob([JSON.stringify(obj,null,2)],{type:'application/json'}));a.href=url;a.download=obj.id+'.edgewidget.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
}
function studio(original,remix=false){
  const n=input(original?.title||'Free memory'),identity=input(remix||!original?'plugin.'+id().slice(0,8):original.id);
  const feed=select([['mac','This Mac'],['json','JSON connection']],original?.feed||'mac',()=>{}),path=input(original?.field||'freeGiB'),unit=input(original?.unit||'GiB'),color=input(original?.accent||'#c4f38f','color');
  const view=select([['number','Number'],['trend','Number with sparkline'],['list','List']],original?.view||'number',()=>{});
  const live=el('output','sub');const preview=button('Test field',async()=>{try{
    const src=config.sources.find(s=>s.kind==='json');if(feed.value==='json'&&!src)throw Error('Add a JSON connection first');
    const data=feed.value==='mac'?await invoke('read_metrics'):await invoke('source_read',{kind:'json',address:src.address});
    live.textContent=String(readPath(data,path.value)??'Field unavailable')+' '+unit.value
  }catch(e){live.textContent=String(e)}});
  formDialog('Widget Studio',[field('Name',n),field('Package ID',identity),field('Source',feed),field('Presentation',view),field('Value field (use dots for nested JSON)',path),field('Units',unit),field('Accent',color),row(preview,live)],()=>{
    const v=plugin({view:view.value,apiVersion:1,id:identity.value,title:n.value,feed:feed.value,field:path.value.trim(),unit:unit.value,accent:color.value});
    if(config.plugins.some(p=>p.id===v.id)&&(!original||remix||v.id!==original.id))throw Error('Package ID already in use');
    change(()=>{if(original&&!remix)config.plugins[config.plugins.indexOf(original)]=v;else config.plugins.push(v)})
  })
}
function plugins(){
  const upload=input('','file');upload.accept='.json';upload.hidden=true;
  upload.onchange=async()=>{try{const f=upload.files[0];if(!f)return;if(f.size>65536)throw Error('Package exceeds 64 KiB');const v=plugin(JSON.parse(await f.text()));const old=config.plugins.find(x=>x.id===v.id);
    formDialog((old?'Update ':'Install ')+v.title,[el('p','',v.feed==='mac'?'Reads a selected Mac metric.':'Reads a field from a JSON connection you select.')],()=>change(()=>{config.plugins=config.plugins.filter(x=>x.id!==v.id);config.plugins.push(v)}))
  }catch(e){notice(e.message)}};
  main.append(heading('Widget Studio',row(button('Install package',()=>upload.click()),decorated('Create widget',()=>studio(),'plus','primary'),upload)));
  const grid=el('div','studio-grid');
  for(const v of config.plugins){
    const card=el('article','panel studio-card');
    card.append(tag('studioFile'),el('h2','',v.title),el('code','',v.field),el('small','',v.feed==='mac'?'Mac system':'JSON connection'),
      row(button('Edit',()=>studio(v)),button('Remix',()=>studio(v,true)),button('Export',()=>download(v)),button('Remove',()=>change(()=>config.plugins=config.plugins.filter(x=>x.id!==v.id)))));
    grid.append(card);
  }
  if(!config.plugins.length){
    const empty=el('div','panel studio-empty');
    empty.append(tag('studio'),el('h2','','Create your first widget'),el('p','sub','Start with a Mac metric or a field from a JSON connection.'),button('Create widget',()=>studio(),'primary'));
    grid.append(empty);
  }
  main.append(grid);
}
function previewButton(){
  return decorated('Show Window Preview',()=>invoke('open_preview').catch(e=>notice(String(e))),'preview','primary');
}
function settingRow(label,control,extra){
  const line=el('div','setting-row'),title=el('label','',label);
  if(control.id)title.htmlFor=control.id;
  line.append(title,control);if(extra)line.append(extra);return line;
}
function preference(key,type){
  const p=general(),control=el('input');control.type=type;control.id='pref-'+key;
  if(type==='checkbox')control.checked=p[key];else control.value=p[key];
  if(type==='number'){control.min=1;control.max=240;control.step=1;}
  const write=()=>{if(!control.reportValidity()||type==='number'&&!control.value)return;
    const value=type==='checkbox'?control.checked:type==='number'?control.valueAsNumber:control.value;
    updateGeneral({[key]:value}).catch(e=>notice(String(e)));
  };
  if(type==='color')control.oninput=write;else control.onchange=write;
  return control;
}
function generalTab(){
  main.append(heading('General',previewButton()));
  main.append(panel('Appearance',settingRow('Primary · text',preference('primary','color')),settingRow('Secondary · highlights',preference('accent','color')),settingRow('Show seconds on the clock',preference('showSeconds','checkbox'))));
  const p=general(),orient=el('div','segments');
  for(const [name,v] of [['Horizontal',false],['Vertical',true]]){
    const b=button(name,()=>{updateGeneral({vertical:v}).catch(e=>notice(String(e)));render()},p.vertical===v?'selected':'');
    b.setAttribute('aria-pressed',String(p.vertical===v));orient.append(b);
  }
  const display=panel('Display'),touch=panel('Touch'),status=el('small','sub');
  const retry=button('Retry',async()=>{try{await invoke('retry_touch');refresh()}catch(e){notice(String(e))}});
  touch.append(settingRow('Direct touch · keep the desktop pointer in place',preference('directTouch','checkbox')),row(status,retry));
  let displaySignature='';
  const draw=d=>{
    if(!display.isConnected)return;
    const prefs=general();
    const states={starting:'Connecting…',on:'Direct touch connected',off:'Direct touch off',needsPermission:'Allow Input Monitoring in macOS',failed:d.touch?.detail||'Touch unavailable'};
    status.textContent=!d.enabled?'Touch released in preview mode':!prefs.directTouch?'Direct touch off':states[d.touch?.state]||'Touch unavailable';
    retry.disabled=!d.enabled||!prefs.directTouch;
    const signature=JSON.stringify([d.displays,d.enabled,d.connected,prefs.display]);
    if(signature===displaySignature)return;
    displaySignature=signature;
    const options=[['','Automatic · XENEON EDGE'],...d.displays.map(x=>[x.id,x.name+' · '+x.width+' × '+x.height])];
    const selected=general().display;
    if(selected&&!options.some(([id])=>id===selected))options.push([selected,'Disconnected display']);
    const target=select(options,selected,async v=>{try{await updateGeneral({display:v});refresh()}catch(e){notice(String(e))}});target.id='output-screen';
    const move=button('Move to display',async()=>{try{await invoke('move_to_display');refresh()}catch(e){notice(String(e))}});
    const mode=d.enabled?'Physical display enabled':'Preview mode';
    const actions=row(el('small','sub',mode),...(d.enabled?[button('Return to preview',async()=>{try{await invoke('set_edge_output',{enabled:false});refresh()}catch(e){notice(String(e))}})]:[]));
    display.replaceChildren(el('h2','','Display'),settingRow('Display',target,move),settingRow('Layout',orient),el('small','sub','For a rotated display, also set its rotation in macOS Displays settings.'),actions);
    document.querySelector('#device-status').textContent=d.enabled?(d.connected?'Display connected':'Awaiting display'):'Preview mode';
    document.querySelector('.hardware-status').classList.toggle('online',!!d.connected);
  };
  const refresh=()=>invoke('display_info').then(draw).catch(e=>{status.textContent=String(e)});
  const updateText=el('small','sub'),release=button('View release',()=>invoke('release_page'));release.hidden=true;
  function showUpdate(r){if(r){updateText.textContent=r.message;release.hidden=!r.available}}
  const check=button('Check for Updates…',async()=>{check.disabled=true;updateText.textContent='Checking…';try{showUpdate(await checkUpdate(true))}finally{check.disabled=false}});
  const updates=panel('Updates',settingRow('Automatically check for updates',preference('autoUpdates','checkbox')),row(check,release,updateText));
  updates.append(el('small','sub','Checks daily. You choose when to download an update.'));
  main.append(touch,display,updates,panel('Focus',settingRow('Focus length (minutes)',preference('focusMinutes','number'))));
  const restoreUpdate=()=>{try{showUpdate(JSON.parse(localStorage.getItem('edge.release.check')))}catch{}};
  restoreUpdate();refresh();
  const poll=setInterval(()=>{if(!display.isConnected){clearInterval(poll);return}refresh();restoreUpdate()},3000);
  cleanupTab=()=>clearInterval(poll);
}
let cleanupTab;
function render(){
  cleanupTab?.();cleanupTab=null;
  const nav=document.querySelector('#nav');nav.replaceChildren();
  for(const [key,label,symbol] of links){
    const b=decorated(label,()=>go(key),symbol,tab===key?'active':'');
    if(tab===key)b.setAttribute('aria-current','page');
    nav.append(b);
  }
  main.replaceChildren();
  if(tab==='Layouts'){main.append(heading('Pages & layouts'));layouts()}
  if(tab==='Connections')connections();
  if(tab==='Widget Studio')plugins();
  if(tab==='General')generalTab();
  if(tab==='Preview'){
    main.append(heading('Live preview',row(button('Edit layout',()=>go('Layouts')),previewButton())));
    const frame=el('section','panel preview-panel'),f=el('iframe','preview');f.title='Current dashboard';f.src='index.html';
    const screen=el('div','preview-screen');screen.append(f);frame.append(screen);main.append(frame);
    cleanupTab=fitDashboard(screen,f);
  }
}
function syncEditor(){
  config=state();undo=[];
  if(tab!=='Preview'&&!document.querySelector('dialog[open]'))render();
}
window.addEventListener('storage',e=>{if(e.key==='edge-workbench.layout.v1')syncEditor()});
render();
loadGeneral().then(()=>{if(tab==='General'||tab==='Layouts')render();automaticUpdates()}).catch(e=>notice(String(e)));
invoke('display_info').then(d=>{
  document.querySelector('#device-status').textContent=d.enabled?(d.connected?'Display connected':'Awaiting display'):'Preview mode';
  document.querySelector('.hardware-status').classList.toggle('online',!!d.connected);
}).catch(()=>document.querySelector('#device-status').textContent='Status unavailable');
importConnections().then(result=>{if(result)syncEditor()}).catch(e=>notice('Connection import: '+String(e)));
