import {slackSettings,takeSlackSetup} from './slack.js';
import {slackWidgets,slackTarget} from './slack-catalog.js';
import {googleSettings,takeGoogleSetup} from './google-desk.js';
import {mountDmd} from './rundmd/player.js';
import {editPhotos} from './photos.js';
import {editShortcuts,shortcutPins} from './mac-shortcuts.js';
import {categories,widgetInfo,installed,connectionsFor,defaultSource,useDefault,placements,removeWidget} from './widget-catalog.js';
import {general,loadGeneral,updateGeneral,fitDashboard,checkUpdate,automaticUpdates} from './general.js';
import {icon} from './admin-icons.js';
import {appendPage,assignWidget,pickWidget} from './page-actions.js';
import {presets,titles,id,resize,split,removeSection,layout,plugin} from './model.js';
import {addBundledDmdPage,ensure,state,current,activate,save,invoke,el,button,field,select} from './common.js';
let config=ensure(),tab='General',chosen=current(config).id,index=0,undo=[],statusTimer;
const main=document.querySelector('#editor');
const links=[['General','General','general'],['Layouts','Pages & layouts','pages'],['Widget Studio','Widget Studio','studio'],['Preview','Live preview','preview'],['About','About','info']];
const sourcesStatus=new Map();
function decorated(label,action,symbol,cls=''){const b=button(label,action,cls);b.prepend(icon(symbol));return b}
function heading(text,actions){const h=el('header','admin-heading');h.append(el('h1','',text));if(actions)h.append(actions);return h}
function tag(kind){const t=el('span','kind-icon');t.dataset.kind=kind;const info=widgetInfo(config,kind);
  if(info?.icon){const image=el('img');image.src=info.icon;image.alt='';t.append(image)}else t.append(icon(kind));
  return t}
function panel(title,...children){const p=section(title,...children);p.classList.add('panel');return p}
let detail=null;
function go(next){tab=next;detail=null;render()}
function widgetSettings(kind){tab='Widget Studio';detail=kind;render()}

const sourceNames={comfy:'ComfyUI',emby:'Emby',proxmox:'Proxmox',omlx:'oMLX',unraid:'Unraid',json:'JSON endpoint'};
function notice(text){const n=document.querySelector('#notice');n.textContent=text;clearTimeout(statusTimer);statusTimer=setTimeout(()=>n.textContent='',6000)}
function input(value='',type='text'){const n=el('input');n.type=type;n.value=value;return n}
function section(title,...children){const s=el('section');s.append(el('h2','',title),...children);return s}
function row(...children){const r=el('div','row');r.append(...children);return r}
function page(){return config.pages.find(p=>p.id===chosen)||config.pages[0]}
function change(fn,layoutEdit=true){
  const before=JSON.stringify(config);
  try{fn();save(config)}catch(e){config=JSON.parse(before);notice(e.message||String(e));return false}
  if(layoutEdit){undo.push(before);if(undo.length>30)undo.shift()}else undo=[];
  render();return true;
}
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
function configureWidget(kind,slot,save,title){
  if(kind==='photos')editPhotos(slot.photoDisplay,photoDisplay=>save({photoDisplay}),{title});
  else editShortcuts(slot.kind==='shortcuts'?shortcutPins(slot):[],shortcutPins=>save({shortcutPins}),{title});
}
function configureSection(p,i,kind='shortcuts'){
  const previous=p.slots[i],before=JSON.stringify(previous);
  configureWidget(kind,previous,properties=>{
    config=state();
    const target=config.pages.find(v=>v.id===p.id),position=target?.slots.findIndex(v=>v.id===previous.id)??-1;
    if(position<0||JSON.stringify(target.slots[position])!==before)throw Error('This section changed. Close and select it again.');
    change(()=>{
      target.slots[position]={...assignWidget(config,kind,previous),...properties};
      chosen=p.id;index=position;activate(target);
    });
  },titles[kind]+' · '+p.name+' · Section '+(i+1));
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
  const assign=(i,kind)=>{
    if(!['photos','shortcuts'].includes(kind))return change(()=>{p.slots[i]=assignWidget(config,kind,p.slots[i]);index=i});
    configureSection(p,i,kind);
  };
  p.slots.forEach((s,i)=>{
    const empty=s.kind==='empty';
    const name=empty?'+ Add widget':titles[s.kind]||config.plugins.find(x=>x.id===s.kind)?.title||'Missing plugin';
    const b=button(name,()=>{
      index=i;render();
      if(empty)pickWidget(config,kind=>assign(i,kind));
    },[i===index?'selected':'',empty?'empty-slot':''].join(' '));
    b.prepend(empty?icon('plus'):tag(s.kind));
    b.setAttribute('aria-pressed',String(i===index));
    b.ondragover=e=>e.preventDefault();
    b.ondrop=e=>{e.preventDefault();const k=e.dataTransfer.getData('text/plain');if(installed(config,k))assign(i,k)};
    const cell=el('div','layout-cell');cell.append(b);
    if(!empty||p.slots.length>1){
      const label=empty?'Remove empty section '+(i+1):'Remove '+name+' from section '+(i+1);
      const remove=button('−',()=>{if(empty)change(()=>{removeSection(p,i);index=Math.min(i,p.slots.length-1)});else assign(i,'empty')},'cell-remove');
      remove.title=label;remove.setAttribute('aria-label',label);cell.append(remove);
    }
    canvas.append(cell);
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
    const matching=connectionsFor(config,s.kind);
    inspector.append(field('Connection',select([['','Choose connection'],...matching.map(x=>[x.id,x.name])],s.source,x=>change(()=>s.source=x))),button('Widget settings',()=>widgetSettings(s.kind)));
  }
  if(slackWidgets[s.kind]?.field){
    const spec=slackWidgets[s.kind],control=input(s.slackTarget||'');control.placeholder=spec.hint;control.maxLength=512;
    inspector.append(field(spec.field,control),button('Apply',()=>{
      if(!slackTarget(s.kind,control.value))return notice('Enter a valid '+spec.field.toLowerCase()+'.');
      change(()=>s.slackTarget=control.value.trim());
    }));
  }
  if(s.kind==='photos')inspector.append(button('Configure photos',()=>configureSection(p,index,'photos')));
  if(s.kind==='shortcuts'){
    const items=shortcutPins(s);
    inspector.append(el('p','sub',items.length?items.map(v=>v.name).join(' · '):'No shortcuts selected.'),button('Choose shortcuts',()=>configureSection(p,index)));
  }
  if(slackWidgets[s.kind]||['spotify','applemusic','googledesk'].includes(s.kind))inspector.append(button('Widget settings',()=>widgetSettings(s.kind)));
  if(s.kind==='disk'){
    const choice=select([['','Startup volume']],s.volume,x=>change(()=>s.volume=x));inspector.append(field('Volume',choice));
    invoke('read_metrics').then(m=>{for(const d of m?.disks||[])choice.add(new Option(d.mount,d.mount));choice.value=s.volume}).catch(()=>{});
  }
  const edits=row(decorated('Split',()=>change(()=>split(p,index,vertical?'row':'column')),'split'),decorated('Stack',()=>change(()=>split(p,index,vertical?'column':'row')),'stack'));
  inspector.append(edits);
  left.append(screen,panel('Layout preset',presetGrid),inspector);
  const lib=el('div','library-list'),search=input();search.type='search';search.placeholder='Find a widget';search.setAttribute('aria-label','Find a widget');
  const searchBox=el('div','search-box');searchBox.append(icon('find'),search);
  const groups=[
    ['Mac system',categories['Mac system']],
    ['Services',[...categories['Service dashboards'],'spotify','applemusic']],
    ['Slack',categories.Slack],
    ['Everyday',categories.Everyday.filter(kind=>!['spotify','applemusic'].includes(kind))],
    ['My widgets',config.plugins.map(v=>v.id)]
  ];
  const fill=()=>{
    lib.replaceChildren();
    const query=search.value.trim().toLowerCase();
    for(const [group,kinds] of groups){
      const rows=[];
      for(const k of kinds){
        const label=widgetInfo(config,k)?.title;
        if(!installed(config,k)||!label||!(label.toLowerCase().includes(query)||k.toLowerCase().includes(query)))continue;
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
function sourceForm(widget,existing){
  const kind=widgetInfo(config,widget).feed,name=input(existing?.name),address=input(existing?.address,'url'),secret=input('','password');
  name.required=address.required=true;secret.autocomplete='new-password';secret.placeholder=existing?'Leave blank to keep saved credential':'Optional';
  const addressField=field('',address),secretField=field('',secret);
  const describe=()=>{const [label,hint,credential]=sourceHelp[kind];addressField.firstChild.textContent=label;address.placeholder=hint;secretField.firstChild.textContent=credential};
  describe();
  formDialog(existing?'Edit connection':'Add connection',[field('Connection name',name),addressField,secretField],async()=>{
    const u=new URL(address.value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error('Use an HTTP(S) URL without embedded credentials or query');
    const obj={id:existing?.id||id(),name:name.value.trim(),kind,address:u.href};
    if(existing?.widgets)obj.widgets=existing.widgets;
    if(existing?.owner||(!existing&&kind==='json'))obj.owner=existing?.owner||widget;
    if(existing?.gpuGuests&&existing.kind===obj.kind&&existing.address===obj.address)obj.gpuGuests=existing.gpuGuests;
    if(!obj.name)throw Error('Enter a connection name');
    if(secret.value)await invoke('set_secret',{kind:obj.kind,address:obj.address,secret:secret.value});
    change(()=>{if(existing)config.sources[config.sources.findIndex(item=>item.id===existing.id)]=obj;else config.sources.push(obj);
      if(connectionsFor(config,widget).length===1)useDefault(config,widget,obj.id);
    },false);
  })
}
function connections(widget){
  const matching=connectionsFor(config,widget);
  const sources=el('section','panel service-panel');
  sources.append(row(el('h2','','Connections'),decorated('Add connection',()=>sourceForm(widget),'plus','primary')));
  const tools=el('div','connection-tools');
  const actions=row(button('Unlock connections',async()=>{
    try{await invoke('unlock_connections');notice('Connections unlocked')}catch(e){notice(String(e))}
  }));
  actions.id='connection-tool-actions';actions.hidden=true;
  const toggle=decorated('Connection tools',()=>{
    actions.hidden=!actions.hidden;
    toggle.setAttribute('aria-expanded',String(!actions.hidden));
  },'connections','connection-tools-toggle');
  toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-controls',actions.id);
  tools.append(toggle,actions);
  if(widgetInfo(config,widget).feed==='json'){
    const legacy=config.sources.filter(s=>s.kind==='json'&&!s.owner&&!matching.some(m=>m.id===s.id));
    if(legacy.length)sources.append(field('Link a saved endpoint',select([['','Choose an endpoint'],...legacy.map(s=>[s.id,s.name])],'',id=>{
      const source=legacy.find(s=>s.id===id);if(!source)return;
      change(()=>{source.widgets=[...new Set([...(source.widgets||[]),widget])];if(!matching.length)useDefault(config,widget,id)},false);
    })));
  }
  if(!matching.length)sources.append(el('p','empty-info','Add a server to connect this widget.'));
  if(matching.length>1)sources.append(field('Default connection',select(matching.map(s=>[s.id,s.name]),defaultSource(config,widget),id=>change(()=>useDefault(config,widget,id),false))));
  for(const s of matching){
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
    menu.append(summary,row(button('Edit',()=>sourceForm(widget,s)),recover,button('Remove',()=>formDialog('Remove '+s.name+'?',[el('p','','Widgets using this connection can be reconnected in Pages & layouts.')],async()=>{
      if(!config.sources.some(other=>other.id!==s.id&&other.kind===s.kind&&((other.kind==='json'?other.address:other.address.replace(/\/+$/,''))===(s.kind==='json'?s.address:s.address.replace(/\/+$/,'')))))await invoke('set_secret',{kind:s.kind,address:s.address,secret:''});
      change(()=>{config.sources=config.sources.filter(x=>x.id!==s.id);
        for(const [kind,id] of Object.entries(config.widgetDefaults||{}))if(id===s.id)delete config.widgetDefaults[kind];
        for(const p of config.pages)for(const w of p.slots)if(w.source===s.id)w.source=defaultSource(config,w.kind);
      },false);
    },'Remove'))));
    actions.append(test,menu);details.append(health);line.append(tag(s.kind),details,el('small','service-type',sourceNames[s.kind]),actions);sources.append(line);
  }
  sources.append(tools);main.append(sources);
}
function widgetDetail(kind){
  const info=widgetInfo(config,kind),uses=placements(config,kind);
  main.append(button('‹ Widget Studio',()=>go('Widget Studio'),'back-link'));
  const title=heading(info.title);title.prepend(tag(kind));main.append(title);
  if(info.description)main.append(el('p','detail-description',info.description));
  if(Object.hasOwn(sourceNames,info.feed))connections(kind);
  if(['spotify','applemusic'].includes(kind)){
    const disc=select([['record','Vinyl record'],['cd','Compact disc'],['none','None']],
      localStorage.getItem('edge.'+kind+'.disc')||'record',value=>localStorage.setItem('edge.'+kind+'.disc',value));
    const spectrum=select([['off','Off'],['on','On']],localStorage.getItem('edge.'+kind+'.spectrum')||(kind==='applemusic'?'on':'off'),
      value=>localStorage.setItem('edge.'+kind+'.spectrum',value));
    main.append(panel('Appearance',field('Disc behind the album cover',disc),field('Playback bar spectrum',spectrum)));
  }
  if(slackWidgets[kind])main.append(panel('Slack workspace',slackSettings()));
  if(['photos','shortcuts'].includes(kind)){
    const spaces=config.pages.flatMap(p=>p.slots.flatMap((s,i)=>s.kind==='empty'?[[s.id,p.name+' · Section '+(i+1)]]:[]));
    const dest=select([['new','New full-screen page'],...spaces],'new',()=>{});
    main.append(panel('Add to a layout',field('Destination',dest),button(kind==='photos'?'Configure photos…':'Choose shortcuts…',()=>{
      if(dest.value!=='new'){
        const target=config.pages.find(p=>p.slots.some(s=>s.id===dest.value));
        if(target)configureSection(target,target.slots.findIndex(s=>s.id===dest.value),kind);
        return;
      }
      configureWidget(kind,{},properties=>{
        config=state();change(()=>{
          const names=new Set(config.pages.map(p=>p.name));
          const next=appendPage(config);next.name=titles[kind];
          for(let n=2;names.has(next.name);n++)next.name=titles[kind]+' '+n;
          next.slots[0]={...assignWidget(config,kind,next.slots[0]),...properties};
          chosen=next.id;index=0;activate(next);tab='Layouts';detail=null;
        });
      },'New '+titles[kind]+' page');
    })));
  }
  if(kind==='googledesk')main.append(panel('Mail and calendar accounts',googleSettings()));
  if(kind==='rundmd'){
    const preview=el('div','dmd-studio-preview');
    main.append(panel('Player',preview,button('Open Run-DMD menu',()=>preview.querySelector('button').click())));
    cleanupTab=mountDmd(preview);
  }
  if(kind==='clock'||kind==='world')main.append(panel('Clock settings',settingRow('Show seconds',preference('showSeconds','checkbox'))));
  if(kind==='focus')main.append(panel('Timer settings',settingRow('Focus length (minutes)',preference('focusMinutes','number'))));
  const locations=panel('Used on pages');
  for(const {page,index:i} of uses){
    const link=button(page.name+' · Section '+(i+1)+'  ›',()=>{chosen=page.id;index=i;go('Layouts')},'placement-link');
    locations.append(link);
  }
  if(!uses.length)locations.append(el('p','sub','This widget hasn’t been placed on a page.'),button('Open layouts',()=>go('Layouts')));
  main.append(locations);
}
function removePackage(info){
  const uses=placements(config,info.kind),count=uses.length;
  const message=count?'Removing this widget will clear '+count+' '+(count===1?'section':'sections')+' across your pages.':'This widget isn’t used on any pages.';
  formDialog('Remove '+info.title+'?',[el('p','',message+' Saved connections are kept.')],()=>change(()=>removeWidget(config,info.kind),false),'Remove widget');
}
function plugins(){
  const upload=input('','file');upload.accept='.zip,.json';upload.hidden=true;
  upload.onchange=async()=>{
    try{
      const f=upload.files[0];if(!f)return;
      const legacy=f.name.toLowerCase().endsWith('.json');
      if(f.size>(legacy?65536:524288))throw Error('Package exceeds '+(legacy?'64':'512')+' KiB');
      const manifest=legacy?JSON.parse(await f.text()):await invoke('read_widget_package',{bytes:Array.from(new Uint8Array(await f.arrayBuffer()))});
      const pkg=plugin(manifest),old=config.plugins.find(p=>p.id===pkg.id);
      if(pkg.iconData){const image=new Image();image.src=pkg.iconData;await image.decode()}
      formDialog((old?'Update ':'Install ')+pkg.title,[el('p','',pkg.description||(pkg.feed==='mac'?'Reads local Mac metrics.':'Reads from a JSON endpoint.'))],()=>{
        const saved=change(()=>{
          if(old){
            config.plugins[config.plugins.findIndex(p=>p.id===pkg.id)]=pkg;
            if(old.feed!==pkg.feed)for(const {page,index} of placements(config,pkg.id))page.slots[index].source=defaultSource(config,pkg.id);
          }else config.plugins.push(pkg);
        },false);
        if(!saved)throw Error('Could not save this package.');
      },old?'Update widget':'Install widget');
    }catch(e){notice(e.message||String(e))}finally{upload.value=''}
  };
  const sample=button('Download example',async()=>{
    sample.disabled=true;
    try{if(await invoke('save_widget_example'))notice('Example package saved.')}catch(e){notice(String(e))}finally{sample.disabled=false}
  });
  const actions=row(sample,decorated('Install package',()=>upload.click(),'plus','primary'),upload);
  main.append(heading('Widget Studio',actions));
  const removed=config.removedWidgets||[];
  if(removed.length){
    const restore=el('details','restore-widgets');restore.append(el('summary','','Restore bundled widgets'));
    const choices=row();for(const k of removed)choices.append(button('Restore '+titles[k],()=>change(()=>{config.removedWidgets=config.removedWidgets.filter(v=>v!==k)},false)));
    restore.append(choices);main.append(restore);
  }
  const groups={'Installed packages':config.plugins.map(p=>p.id),...categories};
  for(const [name,kinds] of Object.entries(groups)){
    const available=kinds.filter(k=>installed(config,k));if(!available.length)continue;
    const section=el('section','studio-group');section.append(el('h2','studio-heading',name));
    const grid=el('div','studio-grid');
    for(const kind of available){
      const info=widgetInfo(config,kind),card=el('article','panel studio-card');
      const title=el('div','card-title');title.append(tag(kind),el('h3','',info.title));
      const count=new Set(placements(config,kind).map(u=>u.page.id)).size;
      const meta=[info.version?'v'+info.version:null,count?count+' '+(count===1?'page':'pages'):'Unplaced'].filter(Boolean).join(' · ');
      card.append(title,el('p','card-description',info.description||(info.feed==='json'?'Reads '+info.field+' from a JSON connection.':'Reads '+info.field+' from this Mac.')),el('small','card-meta',meta));
      const settings=button('Settings',()=>widgetSettings(kind)),remove=button('Remove',()=>removePackage(info),'quiet');
      settings.setAttribute('aria-label',info.title+' settings');remove.setAttribute('aria-label','Remove '+info.title);
      card.append(row(settings,remove));grid.append(card);
    }
    section.append(grid);main.append(section);
  }
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
  if(tab==='About'){
    main.append(document.querySelector('#about-page').content.cloneNode(true));
    for(const link of main.querySelectorAll('a[href]')){
      link.addEventListener('click',event=>{
        event.preventDefault();
        invoke('open_project_link',{url:link.href}).catch(error=>notice(String(error)));
      });
    }
  }
  if(tab==='Layouts'){main.append(heading('Pages & layouts'));layouts()}
  if(tab==='Widget Studio'){if(detail&&installed(config,detail))widgetDetail(detail);else plugins()}
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
window.addEventListener('storage',e=>{if(e.key==='edge.google.setup'&&takeGoogleSetup())widgetSettings('googledesk')});
function openSlackSetup(){const kind=takeSlackSetup();if(kind)widgetSettings(kind);return !!kind}
window.addEventListener('storage',e=>{if(e.key==='edge.slack.setup')openSlackSetup()});
if(!openSlackSetup()){if(takeGoogleSetup())widgetSettings('googledesk');else render()}
invoke('plugin:app|version').then(version=>{document.querySelector('#app-version').textContent='Version '+version}).catch(()=>{});
loadGeneral().then(()=>{if(tab==='General'||tab==='Layouts')render();automaticUpdates()}).catch(e=>notice(String(e)));
invoke('display_info').then(d=>{
  document.querySelector('#device-status').textContent=d.enabled?(d.connected?'Display connected':'Awaiting display'):'Preview mode';
  document.querySelector('.hardware-status').classList.toggle('online',!!d.connected);
}).catch(()=>document.querySelector('#device-status').textContent='Status unavailable');

addBundledDmdPage().then(added=>{if(added)syncEditor()});
