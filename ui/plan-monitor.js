import {button,el,field,invoke,select,state} from './common.js';
import {accountStatus,badges,pace,paceText,primaryWindow,visibleAccounts,windowCaption,windowState} from './plan-model.js';

// Shown before the first snapshot so a placement isn't empty while the collector starts.
const fallbackAccounts=[
  {id:'claude:main',provider:'Claude',name:'Default',windows:[],state:'checking'},
  {id:'codex:local',provider:'Codex',name:'Current account',windows:[],state:'checking'}
];
const viewer=crypto.randomUUID();
const listeners=new Set();
let feed, timer, reading, snapshot, offline=false;

// One shared feed serves every placement and the settings dialog.
function notify(){for(const listener of listeners)listener();}
async function poll(){
  if(reading||!listeners.size)return;
  reading=true;
  try{
    if(feed && !await invoke('widget_ping',{id:feed,viewer}))feed=null;
    feed??=await invoke('widget_open',{kind:'plans',sources:[],viewer});
    const r=await fetch('/widget-view/'+encodeURIComponent(feed)+'/plans.json',{cache:'no-store'});
    if(r.ok){snapshot=await r.json();offline=false;}
    // 404 means the collector hasn't written its first snapshot yet.
    else if(r.status!==404)throw Error('Could not read plan usage.');
  }catch{offline=true;}
  finally{
    reading=false;notify();
    if(!listeners.size)closeFeed();
  }
}
function closeFeed(){
  if(feed){invoke('widget_close',{id:feed,viewer}).catch(()=>{});feed=null;}
}
function subscribe(listener){
  listeners.add(listener);listener();
  if(listeners.size===1){poll();timer=setInterval(poll,5000);}
  return ()=>{
    listeners.delete(listener);
    if(!listeners.size){clearInterval(timer);if(!reading)closeFeed();}
  };
}
async function refreshNow(){
  if(!feed)await poll();
  if(!feed)throw Error('The monitor isn’t running. Try again in a moment.');
  await invoke('plans_refresh',{id:feed,viewer});
}
function accounts(){
  if(!snapshot)return fallbackAccounts;
  const result=[...snapshot.accounts];
  for(const item of fallbackAccounts)if(!result.some(a=>a.provider===item.provider))result.push(item);
  return result;
}
const context=()=>({loaded:!!snapshot,offline});
function settings(slot){return slot.planDisplay || state().planDefaults || {};}

function identity(a,alias){
  const line=el('span','pm-identity'),mark=el('span','pm-mark');
  line.dataset.provider=a.provider;
  const img=el('img');img.src='widget-icons/lobe/'+(a.provider==='Claude'?'claude':'codex')+'-color.svg';img.alt='';
  mark.append(img);
  mark.setAttribute('aria-hidden','true');
  const text=el('span','pm-idtext'),top=el('span','pm-idtop');
  top.append(el('strong','',a.provider));
  if(a.plan)top.append(el('span','pm-plan',a.plan));
  text.append(top,el('span','pm-alias',alias||a.name));
  line.append(mark,text);return line;
}
function dial(w,now){
  const face=el('div','pm-dial'),scale=el('i','pm-scale'),arc=el('i','pm-arc'),center=el('span','pm-dial-center');
  const s=w&&windowState(w,now);
  arc.style.setProperty('--sweep',((s?.left??0)*2.7)+'deg');
  scale.setAttribute('aria-hidden','true');arc.setAttribute('aria-hidden','true');
  if(s){
    const value=el('span','pm-value');value.append(el('b','',String(s.left)),el('small','','%'));
    center.append(value,el('span','pm-dial-label','left'));
    face.setAttribute('role','img');
    face.setAttribute('aria-label',s.left+'% left · '+w.label);
  }else{
    center.append(el('b','pm-no-reading','—'));
    face.setAttribute('aria-hidden','true');
  }
  face.append(scale,arc,center);
  return face;
}
function meter(w,now){
  const s=windowState(w,now),row=el('div','pm-window'),labels=el('div','pm-window-label');
  row.dataset.level=s.level;
  const when=s.expired?'reset':s.idle?'not started':w.reset?windowCaption(w,now).replace('Resets in ','resets '):'';
  const value=el('b','',s.left+'% left');
  labels.append(el('span','',w.label),value);
  const bar=el('div','pm-track'),fill=el('i');fill.style.width=s.left+'%';bar.append(fill);
  row.append(labels,bar);
  if(when)row.append(el('small','pm-when',when));
  return row;
}

function accountCard(a,alias,now){
  const card=el('section','pm-account'),status=accountStatus(a,now,context());
  card.dataset.provider=a.provider;
  card.setAttribute('aria-label',a.provider+' · '+(alias||a.name));
  card.append(identity(a,alias));
  const primary=status.reading?primaryWindow(a.windows,now):null,s=primary&&windowState(primary,now);
  card.dataset.level=s?.level||'none';
  const main=el('div','pm-instrument'),caption=el('div','pm-summary');
  main.append(dial(primary,now));
  if(primary){
    caption.append(el('strong','pm-caption',primary.label+' allowance'));
    const when=windowCaption(primary,now);
    if(when)caption.append(el('span','pm-reset',when));
    const ahead=paceText(pace(primary,now),primary.reset,now);
    if(ahead){const line=el('span','pm-pace',ahead);line.dataset.warn=String(ahead.startsWith('At this pace'));caption.append(line);}
  }else{
    caption.append(el('strong','pm-caption',status.title));
    if(status.detail)caption.append(el('span','pm-reset pm-guidance',status.detail));
  }
  main.append(caption);card.append(main);
  const others=primary?a.windows.filter(w=>w!==primary&&windowState(w,now)):[];
  if(others.length){
    const meters=el('div','pm-meters');
    for(const w of others.slice(0,3))meters.append(meter(w,now));
    card.append(meters);
  }
  const foot=el('div','pm-foot');
  if(status.reading){
    const stamp=el('span','pm-stamp',status.title);stamp.dataset.tone=status.tone;
    if(status.detail)stamp.title=status.detail;
    foot.append(stamp);
  }
  for(const b of badges(a)){const chip=el('span','pm-chip',b.text);chip.dataset.tone=b.tone;foot.append(chip);}
  if(foot.childElementCount)card.append(foot);
  if(status.reading&&status.tone==='warn'&&status.detail)card.append(el('p','pm-stale',status.detail));
  return card;
}

export function editPlans(slot,save,{title='AI Plan Monitor · This placement'}={}){
  const initial=settings(slot),aliases={...initial.aliases};
  let mode=initial.mode||'overview',ids=initial.ids ? [...initial.ids]:null,pin=initial.pin||'';
  const dialog=el('dialog','pm-dialog'),form=el('div','pm-form'),list=el('div','pm-choices'),status=el('p','pm-error');
  status.setAttribute('role','status');
  dialog.setAttribute('aria-label',title);
  const choose=select([['overview','Every chosen account'],['account','One account, full size']],mode,value=>{mode=value;draw();});
  const all=el('input');all.type='checkbox';all.checked=ids===null;
  const allField=field('Include accounts found later',all);
  all.onchange=()=>{ids=all.checked?null:accounts().map(a=>a.id);draw();};
  function rename(a,row){
    const apply=value=>{aliases[a.id]=value.trim().slice(0,48);draw();};
    const input=el('input');input.type='text';input.value=aliases[a.id]||'';input.placeholder=a.name;input.maxLength=48;input.setAttribute('aria-label','Name for '+a.provider+' · '+a.name);
    const renameForm=el('form','pm-rename');const done=el('button','','Apply');renameForm.append(input,done);
    renameForm.onsubmit=e=>{e.preventDefault();apply(input.value);};list.querySelector('.pm-rename')?.remove();row.after(renameForm);input.focus();
  }
  function draw(){
    allField.hidden=mode!=='overview';list.replaceChildren();
    const options=accounts(),now=Date.now();
    for(const id of new Set([...(ids||[]),pin].filter(Boolean)))if(!options.some(a=>a.id===id))
      options.push({id,provider:id.startsWith('claude:')?'Claude':'Codex',name:'No longer on this Mac',windows:[],state:'missing'});
    if(!pin||!options.some(a=>a.id===pin))pin=options[0]?.id||'';
    for(const a of options){
      const row=el('div','pm-choice'),toggle=el('input');toggle.type=mode==='account'?'radio':'checkbox';toggle.name='pm-account';
      toggle.checked=mode==='account'?pin===a.id:ids===null||ids.includes(a.id);
      toggle.onchange=()=>{
        if(mode==='account')pin=a.id;
        else{ids??=options.map(o=>o.id);ids=toggle.checked?[...new Set([...ids,a.id])]:ids.filter(id=>id!==a.id);all.checked=false;}
      };
      const s=accountStatus(a,now,context()),p=s.reading&&primaryWindow(a.windows,now);
      const summary=el('span','pm-choice-status',p?windowState(p,now).left+'% left · '+p.label+' · '+s.title:s.title+(s.detail?' — '+s.detail:''));
      summary.dataset.tone=s.tone;
      const label=el('label'),who=el('span','pm-choice-who');who.append(identity(a,aliases[a.id]),summary);
      label.append(toggle,who);row.append(label,button('Rename',()=>rename(a,row)));list.append(row);
    }
  }
  const check=button('Check now',async()=>{
    check.disabled=true;status.textContent='Checking every account…';
    try{await refreshNow();status.textContent='Checking every account. Results appear as each one answers.';}
    catch(e){status.textContent=String(e.message||e);}
    finally{check.disabled=false;}
  });
  const footer=el('footer'),spacer=el('span','pm-spacer');
  footer.append(check,spacer,button('Cancel',()=>dialog.close()),button('Save',()=>{
    if(mode==='overview'&&ids?.length===0){status.textContent='Select an account to display.';return;}
    try{save({mode,ids,pin,aliases});dialog.close();}catch(e){status.textContent=String(e.message||e);}
  }));
  form.append(field('Show',choose),allField,list,status,footer);dialog.append(el('h2','',title),form);
  document.body.append(dialog);dialog.showModal();
  let catalogKey='';
  const stop=subscribe(()=>{
    const now=Date.now(),key=JSON.stringify([accounts().map(a=>[a.id,a.name,a.plan,a.state,a.at,a.stale]),offline,Math.floor(now/60000)]);
    if(key===catalogKey)return;catalogKey=key;
    // Keep an open rename field and the user's keyboard focus across a live update.
    if(!list.querySelector('.pm-rename'))draw();
  });
  dialog.onclose=()=>{stop();dialog.remove();};
}

export function mountPlans(box,slot){
  const prefs=settings(slot);
  box.classList.add('pm-widget');
  box.setAttribute('aria-label','AI Plan Monitor');
  const view=el('div','pm-accounts');box.append(view);
  let key='';
  function draw(){
    const now=Date.now(),visible=visibleAccounts(accounts(),prefs);
    const version=JSON.stringify([visible,!!snapshot,offline,Math.floor(now/60000)]);
    if(version===key)return;key=version;
    const scroll=view.scrollLeft;
    view.replaceChildren();box.dataset.single=String(visible.length===1);box.dataset.count=String(visible.length);
    if(!visible.length){
      const empty=el('div','pm-empty');
      empty.append(el('strong','','Account not on this Mac'),el('span','','Choose accounts for this placement in Pages & layouts.'));
      view.append(empty);
    }
    for(const a of visible)view.append(accountCard(a,prefs.aliases?.[a.id],now));
    view.scrollLeft=scroll;
  }
  return subscribe(draw);
}
