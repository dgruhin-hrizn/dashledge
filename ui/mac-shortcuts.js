import {button, el, invoke} from './common.js';
import {openTouchKeyboard} from './search-keyboard.js';
import {icon} from './admin-icons.js';

const pinsKey='edge.shortcuts.pins';
const colors={Iris:'#b39bff',Lagoon:'#77d7d2',Rose:'#f19fb8',Amber:'#f1bf83',Sky:'#90bfff',Fern:'#a9cf90'};
const symbols={power:'Bolt',clock:'Clock',display:'Display',notes:'Note',network:'Arrows',spotify:'Audio',general:'Sliders',studio:'Grid'};
const pins=()=>{try{return JSON.parse(localStorage.getItem(pinsKey))||[]}catch{return []}};
export const shortcutPins=slot=>Array.isArray(slot.shortcutPins)?slot.shortcutPins:pins();
function brand(){
  const image=el('img','sc-mark');image.src='widget-icons/shortcuts.svg';image.alt='';return image;
}
export function mountShortcuts(box,slot,onSave){
  box.classList.add('sc-widget');
  const header=el('header','sc-head'),grid=el('div','sc-grid'),notice=el('div','sc-notice');
  notice.setAttribute('role','status');
  const configure=()=>editShortcuts(shortcutPins(slot),onSave,{touch:true});
  const edit=button('',configure,'sc-edit');edit.append(icon('general'));edit.setAttribute('aria-label','Configure shortcuts');
  header.append(brand(),el('h2','','Shortcuts'),edit);
  box.append(header,grid,notice);
  const states=new Map(),timers=new Map();
  function paint(){
    grid.replaceChildren();
    const items=shortcutPins(slot);
    grid.style.setProperty('--sc-count',Math.min(4,items.length)||1);
    grid.style.setProperty('--sc-narrow',Math.min(2,items.length)||1);
    if(!items.length){
      const empty=el('div','sc-empty');
      empty.append(el('strong','','Your shortcuts go here'),button('Choose shortcuts',configure));
      grid.append(empty);return;
    }
    for(const item of items){
      const status=states.get(item.id);
      const key=button('',async()=>{
        if(states.get(item.id)==='Running…')return;
        clearTimeout(timers.get(item.id));states.set(item.id,'Running…');notice.textContent='';paint();
        try{await invoke('mac_shortcut_run',{id:item.id});states.set(item.id,'Finished')}
        catch(e){states.set(item.id,'Failed');notice.textContent=String(e)}
        if(disposed)return;
        paint();timers.set(item.id,setTimeout(()=>{states.delete(item.id);paint()},3000));
      },'sc-key');
      key.disabled=status==='Running…';
      key.style.setProperty('--tint',colors[item.color]||colors.Iris);
      const top=el('span','sc-key-top'),play=el('span','sc-play',status==='Finished'?'✓':'▸');
      play.setAttribute('aria-hidden','true');top.append(icon(item.symbol),play);
      key.append(top,el('strong','',item.name));
      if(status)key.append(el('span','sc-state',status));
      key.setAttribute('aria-label','Run '+item.name+(status?', '+status:''));
      grid.append(key);
    }
  }
  let disposed=false;
  const onStorage=e=>{if(e.key===pinsKey)paint()};
  window.addEventListener('storage',onStorage);paint();
  return ()=>{disposed=true;window.removeEventListener('storage',onStorage);for(const timer of timers.values())clearTimeout(timer)};
}

export function editShortcuts(initial,onSave,{touch=false,title='Configure shortcuts'}={}){
  const draft=initial.map(item=>({...item}));
  let active=draft[0]?.id,available=[],loaded=false,query='';
  const dialog=el('dialog','sc-dialog'),header=el('header'),body=el('div','sc-columns');
  dialog.setAttribute('aria-label',title);
  header.append(brand(),el('h2','',title));
  const left=el('div','sc-pane'),right=el('div','sc-pane'),results=el('div','sc-results');
  const libraryHead=el('div','sc-line'),reload=button('Refresh',refresh);
  libraryHead.append(el('h3','','Mac library'),reload);
  const filter=touch?button('Search shortcuts',()=>{
    const sheet=openTouchKeyboard({title:'Find a shortcut',brand:'Mac Shortcuts',icon:'widget-icons/shortcuts.svg',placeholder:'Shortcut name',onSubmit:()=>{
      setQuery(sheet.input.value);sheet.dialog.close();
    }});
    sheet.input.value=query;sheet.input.select();
  }):el('input');
  if(!touch){filter.type='search';filter.placeholder='Search shortcuts';filter.setAttribute('aria-label','Search shortcuts');filter.oninput=()=>setQuery(filter.value)}
  const clear=button('Clear',()=>{if(!touch)filter.value='';setQuery('')});clear.hidden=true;
  const search=el('div','sc-filter');search.append(filter,clear);
  function setQuery(value){query=value.trim();if(touch)filter.textContent=query||'Search shortcuts';clear.hidden=!query;drawLibrary()}
  left.append(libraryHead,search,results);
  const keys=el('div','sc-preview'),tools=el('div','sc-tools'),count=el('h3');
  right.append(count,keys,tools);
  const footer=el('footer'),error=el('span');error.setAttribute('role','alert');
  const commit=button('Save shortcuts',()=>{
    try{onSave(draft);dialog.close()}catch(e){error.textContent=e.message||String(e)}
  },'primary');
  footer.append(error,button('Cancel',()=>dialog.close()),commit);
  function drawLibrary(){
    if(!loaded)return;
    results.replaceChildren();
    const matches=available.filter(item=>item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    for(const item of matches){
      const pinned=draft.some(p=>p.id===item.id);
      const b=button('',()=>{
        if(!pinned)draft.push({...item,color:Object.keys(colors)[draft.length%Object.keys(colors).length],symbol:'power'});
        active=item.id;draw();
      },'sc-option');
      b.dataset.focus='library-'+item.id;
      b.setAttribute('aria-label',(pinned?'Edit ':'Add ')+item.name);
      b.append(el('span','',item.name),icon(pinned?'check':'plus'));results.append(b);
    }
    if(!matches.length)results.append(el('p','sub',available.length?'No matching shortcuts.':'Create a shortcut in the Shortcuts app on this Mac, then refresh.'));
  }
  function draw(){
    const focus=document.activeElement?.dataset.focus;
    commit.disabled=!draft.length&&!initial.length;
    count.textContent='In this section · '+draft.length;
    keys.replaceChildren();tools.replaceChildren();
    if(!draft.length)keys.append(el('p','sub','Choose shortcuts from your Mac library.'));
    for(const item of draft){
      const key=button('',()=>{active=item.id;draw()},'sc-preview-key');
      key.dataset.focus='key-'+item.id;
      key.style.setProperty('--tint',colors[item.color]||colors.Iris);key.setAttribute('aria-pressed',String(item.id===active));
      key.append(icon(item.symbol),el('strong','',item.name));keys.append(key);
    }
    const index=draft.findIndex(p=>p.id===active),item=draft[index];
    if(item){
      const controls=el('div','sc-line');
      const move=delta=>{const j=index+delta;[draft[index],draft[j]]=[draft[j],draft[index]];draw()};
      const earlier=button('← Earlier',()=>move(-1)),later=button('Later →',()=>move(1));
      earlier.disabled=index===0;later.disabled=index===draft.length-1;
      controls.append(earlier,later,button('Remove',()=>{draft.splice(index,1);active=draft[Math.min(index,draft.length-1)]?.id;draw()}));
      tools.append(el('h4','',item.name),controls);
      for(const [prop,options,label] of [['color',colors,'Color'],['symbol',symbols,'Icon']]){
        const group=el('div','sc-swatches');group.setAttribute('role','group');group.setAttribute('aria-label',label);
        for(const [key,value] of Object.entries(options)){
          const name=prop==='color'?key:value;
          const b=button('',()=>{item[prop]=key;draw()});b.title=name;b.dataset.focus=prop+'-'+key;b.setAttribute('aria-label',name);b.setAttribute('aria-pressed',String(item[prop]===key));
          if(prop==='color'){const dot=el('i');dot.style.background=value;b.append(dot)}else b.append(icon(key));
          group.append(b);
        }
        tools.append(group);
      }
      if(loaded&&!available.some(a=>a.id===item.id))tools.append(el('p','sub','This shortcut is missing from the Mac library.'));
    }
    drawLibrary();
    if(focus)Array.from(dialog.querySelectorAll('[data-focus]')).find(b=>b.dataset.focus===focus)?.focus({preventScroll:true});
  }
  async function refresh(){
    loaded=false;reload.disabled=true;results.replaceChildren(el('p','sub','Reading Mac shortcuts…'));
    try{
      available=await invoke('mac_shortcuts_list');loaded=true;
      const names=new Map(available.map(a=>[a.id,a.name]));
      for(const item of draft)item.name=names.get(item.id)||item.name;
      draw();
    }catch(e){results.replaceChildren(el('p','sub','Couldn’t read your Mac shortcuts. '+String(e)))}
    finally{reload.disabled=false}
  }
  body.append(left,right);dialog.append(header,body,footer);document.body.append(dialog);
  dialog.onclose=()=>dialog.remove();dialog.showModal();draw();refresh();
}
