import {presets,titles,slot,id,makePage,resize,split,layout,plugin,readPath} from './model.js';
import {ensure,current,activate,save,invoke,el,button,field,select} from './common.js';
let config=ensure(),tab='Layouts',chosen=current(config).id,index=0,undo=[],statusTimer;
const main=document.querySelector('#editor');
const sourceNames={comfy:'ComfyUI',emby:'Emby',proxmox:'Proxmox',omlx:'oMLX',unraid:'Unraid',json:'JSON endpoint'};
function notice(text){const n=document.querySelector('#notice');n.textContent=text;clearTimeout(statusTimer);statusTimer=setTimeout(()=>n.textContent='',6000)}
function input(value='',type='text'){const n=el('input');n.type=type;n.value=value;return n}
function section(title,...children){const s=el('section');s.append(el('h2','',title),...children);return s}
function row(...children){const r=el('div','row');r.append(...children);return r}
function page(){return config.pages.find(p=>p.id===chosen)||config.pages[0]}
function change(fn){const before=JSON.stringify(config);try{fn();save(config);undo.push(before);if(undo.length>30)undo.shift();render()}catch(e){config=JSON.parse(before);notice(e.message||String(e))}}
function formDialog(title,fields,apply){const d=el('dialog'),f=el('form','fields');f.append(el('h2','',title),...fields);const ok=el('button','primary','Save');f.append(row(button('Cancel',()=>d.close()),ok));d.append(f);document.body.append(d);d.onclose=()=>d.remove();f.onsubmit=async e=>{e.preventDefault();ok.disabled=true;try{await apply();d.close()}catch(e){notice(e.message||String(e))}finally{ok.disabled=false}};d.showModal()}
function nameDialog(title,value,cb){const n=input(value);n.required=true;n.maxLength=60;formDialog(title,[field('Name',n)],()=>{if(!n.value.trim())throw Error('Enter a name');cb(n.value.trim())})}
function pageControls(p){
  const move=delta=>change(()=>{let i=config.pages.indexOf(p),j=i+delta;if(j>=0&&j<config.pages.length)[config.pages[i],config.pages[j]]=[config.pages[j],config.pages[i]]});
  return row(button('New page',()=>nameDialog('New page','',name=>change(()=>{const n=makePage(name,'One');config.pages.push(n);chosen=n.id;index=0;activate(n)})),'primary'),
    button('Rename',()=>nameDialog('Rename page',p.name,name=>change(()=>p.name=name))),
    button('Move left',()=>move(-1)),button('Move right',()=>move(1)),
    button('Delete',()=>{if(config.pages.length===1)return notice('Keep at least one page.');formDialog('Delete '+p.name+'?',[el('p','sub','Undo can restore this page.')],()=>change(()=>{config.pages.splice(config.pages.indexOf(p),1);chosen=config.pages[0].id;index=0;activate(page())}))}),
    button('Undo',()=>{if(!undo.length)return notice('No edits to undo');config=JSON.parse(undo.pop());save(config);chosen=page().id;index=0;activate(page());render()}));
}
function layouts(){
  const p=page();index=Math.min(index,p.slots.length-1);
  const pages=el('div','tabs');for(const item of config.pages)pages.append(button(item.name,()=>{chosen=item.id;index=0;activate(item);render()},p.id===item.id?'selected':''));
  const canvas=el('div','canvas');
  const assign=(i,kind)=>change(()=>{p.slots[i]=slot(kind);const feed=kind.startsWith('plugin.')?config.plugins.find(v=>v.id===kind)?.feed:kind;p.slots[i].source=config.sources.find(s=>s.kind===feed)?.id||'';index=i});
  p.slots.forEach((s,i)=>{const b=button(titles[s.kind]||config.plugins.find(x=>x.id===s.kind)?.title||'Missing plugin',()=>{index=i;render()},i===index?'selected':'');b.ondragover=e=>e.preventDefault();b.ondrop=e=>{e.preventDefault();const k=e.dataTransfer.getData('text/plain');if(Object.hasOwn(titles,k)||config.plugins.some(x=>x.id===k))assign(i,k)};canvas.append(b)});
  layout(canvas,p.preset,p.regions);const preset=row(...Object.keys(presets).map(key=>button(key,()=>change(()=>resize(p,key)),p.preset===key&&!p.regions?'active':'')));
  main.append(pages,pageControls(p),canvas,preset,row(button('Split side by side',()=>change(()=>split(p,index,'column'))),button('Stack vertically',()=>change(()=>split(p,index,'row')))));
  const s=p.slots[index],feed=config.plugins.find(x=>x.id===s.kind)?.feed||s.kind;
  if(Object.hasOwn(sourceNames,feed)){
    const matching=config.sources.filter(x=>x.kind===feed);
    main.append(field('Connection',select([['','Choose connection'],...matching.map(x=>[x.id,x.name])],s.source,x=>change(()=>s.source=x))),button('Manage connections',()=>{tab='Connections';render()}));
  }
  if(s.kind==='disk'){const choice=select([['','Startup volume']],s.volume,x=>change(()=>s.volume=x));main.append(field('Volume',choice));invoke('read_metrics').then(m=>{for(const d of m?.disks||[])choice.add(new Option(d.mount,d.mount));choice.value=s.volume}).catch(()=>{})}
  const lib=el('div','catalog'),search=input();search.placeholder='Find a widget';
  const fill=()=>{lib.replaceChildren();for(const [k,label] of [...Object.entries(titles),...config.plugins.map(v=>[v.id,v.title])]){
    if(!label.toLowerCase().includes(search.value.toLowerCase()))continue;
    const b=button(label,()=>assign(index,k),s.kind===k?'selected':'');b.draggable=true;b.ondragstart=e=>e.dataTransfer.setData('text/plain',k);lib.append(b)
  }};search.oninput=fill;fill();main.append(section('Section '+(index+1)+' · Widget library',search,lib));
}
function sourceForm(existing){
  const kind=select(Object.entries(sourceNames),existing?.kind||'comfy',()=>{}),name=input(existing?.name),address=input(existing?.address,'url'),secret=input('','password');
  name.required=address.required=true;secret.autocomplete='new-password';secret.placeholder=existing?'Leave blank to keep saved credential':'Optional';
  formDialog(existing?'Edit connection':'New connection',[field('Service',kind),field('Name',name),field('Base URL or JSON endpoint',address),field('Token (Proxmox uses token ID=secret)',secret),el('small','','For Unraid use the monitoring API base; for Emby include /emby if required.')],async()=>{
    const u=new URL(address.value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error('Use an HTTP(S) URL without embedded credentials or query');
    const obj={id:existing?.id||id(),name:name.value.trim(),kind:kind.value,address:u.href};
    if(!obj.name)throw Error('Enter a connection name');
    if(secret.value)await invoke('set_secret',{kind:obj.kind,address:obj.address,secret:secret.value});
    change(()=>{if(existing)config.sources[config.sources.indexOf(existing)]=obj;else config.sources.push(obj)});
  })
}
function connections(){
  main.append(button('Add connection',()=>sourceForm(),'primary'));
  for(const s of config.sources){
    const status=el('small','',s.address);const test=button('Test',async()=>{test.disabled=true;status.textContent='Connecting…';try{await invoke('source_read',{kind:s.kind,address:s.address});status.textContent='Connected'}catch(e){status.textContent=String(e)}finally{test.disabled=false}});
    main.append(section(s.name,row(el('small','',sourceNames[s.kind]),status),row(test,button('Edit',()=>sourceForm(s)),button('Remove',()=>formDialog('Remove '+s.name+'?',[el('p','','Tiles using this source can be reconnected in Layouts.')],async()=>{
      if(!config.sources.some(other=>other.id!==s.id&&other.kind===s.kind&&other.address===s.address))await invoke('set_secret',{kind:s.kind,address:s.address,secret:''});change(()=>config.sources=config.sources.filter(x=>x.id!==s.id));
    })))));
  }
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
  main.append(row(button('Create widget',()=>studio(),'primary'),button('Install package',()=>upload.click()),upload));
  for(const v of config.plugins)main.append(section(v.title,el('small','',v.feed+' · '+v.field),row(button('Edit',()=>studio(v)),button('Remix',()=>studio(v,true)),button('Export',()=>download(v)),button('Remove',()=>change(()=>config.plugins=config.plugins.filter(x=>x.id!==v.id))))));
}
function render(){
  const nav=document.querySelector('#nav');nav.replaceChildren();
  for(const n of ['Layouts','Connections','Widget Studio','Preview','Display'])nav.append(button(n,()=>{tab=n;render()},tab===n?'active':''));
  main.replaceChildren(el('h1','',tab));
  if(tab==='Layouts')layouts();if(tab==='Connections')connections();if(tab==='Widget Studio')plugins();
  if(tab==='Display'){
    const info=section('XENEON Edge',el('p','sub','Detecting display…'));main.append(info);
    invoke('display_info').then(d=>{
      info.replaceChildren(el('h2','','XENEON Edge'),
        el('p','',d.connected?'Connected · '+d.size+' points':'Waiting for a connected Edge'),
        el('p','sub',d.enabled?'Edge output enabled':'Preview mode · Touch stays available to your current display app'),
        button(d.enabled?'Return to preview…':'Enable Edge output…',()=>formDialog('Restart Edge Workbench?',
          [el('p','',d.enabled?'The app will reopen in preview mode.':'Quit any other app using Edge touch first. Workbench will reopen on the panel. macOS may ask for Input Monitoring.')],
          ()=>invoke('set_edge_output',{enabled:!d.enabled}))));
    }).catch(e=>info.append(el('p','',String(e))));
  }
  if(tab==='Preview'){const f=el('iframe','preview');f.title='Current dashboard';f.src='index.html';main.append(f)}
}
render();
