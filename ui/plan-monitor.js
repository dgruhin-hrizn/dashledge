import {button,el,field,invoke,select,state} from './common.js';
import {openTouchKeyboard} from './search-keyboard.js';

const fallbackAccounts=[
  {id:'claude:main',provider:'Claude',name:'Default',windows:[]},
  {id:'codex:local',provider:'Codex',name:'Current account',windows:[]}
];
const viewer=crypto.randomUUID();
const listeners=new Set();
let feed, timer, reading, snapshot, feedError='';
function notify(){for(const listener of listeners)listener();}
async function poll(){
  if(reading||!listeners.size)return;
  reading=true;
  try{
    if(feed && !await invoke('widget_ping',{id:feed,viewer}))feed=null;
    feed??=await invoke('widget_open',{kind:'plans',sources:[],viewer});
    const r=await fetch('/widget-view/'+encodeURIComponent(feed)+'/plans.json',{cache:'no-store'});
    if(r.ok){snapshot=await r.json();feedError='';}
    else if(r.status!==404)throw Error('Could not read plan usage.');
  }catch(e){feedError=String(e);}
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
function accounts(){
  if(!snapshot)return fallbackAccounts;
  const result=[...snapshot.accounts];
  for(const item of fallbackAccounts)if(!result.some(a=>a.provider===item.provider))result.push(item);
  return result;
}
function settings(slot){return slot.planDisplay || state().planDefaults || {};}
function windowLabel(w){return ({five_hour:'5-hour',seven_day:'Weekly'})[w.label]||w.label;}
function valid(w,now){return Number.isFinite(w.used) && (!w.reset || w.reset>now);}
function remaining(w){return Math.round((100-w.used)*10)/10;}
const dateFormat=new Intl.DateTimeFormat(undefined,{weekday:'short',hour:'numeric',minute:'2-digit'});
function until(ts,now){
  const mins=Math.max(1,Math.ceil((ts-now)/60000));
  if(mins<60)return mins+'m';
  if(mins<1440)return Math.floor(mins/60)+'h '+mins%60+'m';
  return Math.floor(mins/1440)+'d '+Math.floor(mins%1440/60)+'h';
}
function identity(a,alias){
  const line=el('span','pm-identity'),mark=el('span','pm-mark');
  if(a.provider==='Claude'){const img=el('img');img.src='widget-icons/anthropic.svg';img.alt='';mark.append(img);}
  else mark.textContent='›_';
  mark.setAttribute('aria-hidden','true');
  const text=el('span','pm-idtext');
  text.append(el('strong','',a.provider),el('span','',alias||a.name));
  line.append(mark,text);return line;
}
function readingTime(a,now){
  if(!a.at)return 'No reading yet';
  const mins=Math.max(0,Math.floor((now-a.at)/60000));
  return mins<1?'Updated just now':mins<60?'Updated '+mins+'m ago':mins<1440?'Updated '+Math.floor(mins/60)+'h ago':'Updated '+Math.floor(mins/1440)+'d ago';
}
function guidance(a){return a.provider==='Claude'?'Open Ember or sign in to Claude Code on this Mac.':'Sign in to Codex with your ChatGPT account on this Mac.';}
function metric(w,now){
  const row=el('div','pm-window'),labels=el('div','pm-window-label');
  const live=valid(w,now),bar=el('div','pm-track');
  labels.append(el('span','',windowLabel(w)),el('b','',live?remaining(w)+'% left':'Awaiting refresh'));
  const fill=el('i');fill.style.width=(live?remaining(w):0)+'%';bar.append(fill);
  row.append(labels,bar);return row;
}
function details(a,alias,onConfigure){
  const dialog=el('dialog','pm-dialog');
  dialog.setAttribute('aria-label',a.provider+' account details');
  const top=el('header');top.append(identity(a,alias),button('Close',()=>dialog.close()));
  const body=el('div','pm-detail-body');
  const draw=()=>{
    const item=accounts().find(row=>row.id===a.id)||a,now=Date.now();
    body.replaceChildren(el('p','',(item.source||item.provider)+' · '+readingTime(item,now)));
    for(const w of item.windows){
      body.append(metric(w,now));
      if(w.reset)body.append(el('small','', 'Reset · '+new Date(w.reset).toLocaleString()));
    }
    if(!item.windows.length)body.append(el('p','',guidance(item)));
  };
  const actions=el('footer'),refresh=button('Refresh',async()=>{
    refresh.disabled=true;
    try{
      if(!feed)await poll();
      if(!feed)throw Error('Open the monitor in Dashledge to reconnect.');
      await invoke('plans_refresh',{id:feed,viewer});message.textContent='Refresh requested.';
    }catch(e){message.textContent=String(e);}finally{refresh.disabled=false;}
  }),message=el('p');message.setAttribute('role','status');
  actions.append(refresh,button('Configure placement',()=>{dialog.close();onConfigure();}));
  dialog.append(top,body,message,actions);
  document.body.append(dialog);dialog.showModal();
  const stop=subscribe(draw);dialog.onclose=()=>{stop();dialog.remove();};
}

export function editPlans(slot,save,{title='AI Plan Monitor · This placement',touch=false}={}){
  const initial=settings(slot),aliases={...initial.aliases};
  let mode=initial.mode||'overview',ids=initial.ids ? [...initial.ids]:null,pin=initial.pin||'';
  const dialog=el('dialog','pm-dialog'),form=el('div','pm-form'),list=el('div','pm-choices'),status=el('p','pm-error');
  dialog.setAttribute('aria-label',title);
  const choose=select([['overview','Plan overview'],['account','Account meter']],mode,value=>{mode=value;draw();});
  const all=el('input');all.type='checkbox';all.checked=ids===null;
  const allField=field('Include all discovered accounts',all);
  all.onchange=()=>{ids=all.checked?null:accounts().map(a=>a.id);draw();};
  function rename(a,row){
    const apply=value=>{aliases[a.id]=value.trim().slice(0,48);draw();};
    if(touch){
      const sheet=openTouchKeyboard({title:'Name this account',brand:'AI Plan Monitor',icon:'widget-icons/plans.svg',placeholder:a.name,actionLabel:'Apply',maxLength:48,onSubmit:()=>{apply(sheet.input.value);sheet.dialog.close();}});
      sheet.input.value=aliases[a.id]||'';return;
    }
    const input=el('input');input.value=aliases[a.id]||'';input.placeholder=a.name;input.maxLength=48;input.setAttribute('aria-label','Account name');
    const renameForm=el('form','pm-rename');const done=el('button','','Apply');renameForm.append(input,done);
    renameForm.onsubmit=e=>{e.preventDefault();apply(input.value);};list.querySelector('.pm-rename')?.remove();row.after(renameForm);input.focus();
  }
  function draw(){
    allField.hidden=mode!=='overview';list.replaceChildren();
    const options=accounts();
    for(const id of new Set([...(ids||[]),pin].filter(Boolean)))if(!options.some(a=>a.id===id))options.push({id,provider:id.startsWith('claude:')?'Claude':'Codex',name:'Saved account'});
    if(!pin)pin=options[0]?.id||'';
    for(const a of options){
      const row=el('div','pm-choice'),toggle=el('input');toggle.type=mode==='account'?'radio':'checkbox';toggle.name='pm-account';
      toggle.checked=mode==='account'?pin===a.id:ids===null||ids.includes(a.id);
      toggle.disabled=mode==='overview'&&ids===null;
      toggle.onchange=()=>{if(mode==='account')pin=a.id;else ids=toggle.checked?[...ids,a.id]:ids.filter(id=>id!==a.id);};
      const label=el('label');label.append(toggle,identity(a,aliases[a.id]));row.append(label,button('Rename',()=>rename(a,row)));list.append(row);
    }
  }
  const footer=el('footer');footer.append(button('Cancel',()=>dialog.close()),button('Save',()=>{
    if(mode==='overview'&&ids?.length===0){status.textContent='Select an account to display.';return;}
    try{save({mode,ids,pin,aliases});dialog.close();}catch(e){status.textContent=String(e);}
  }));
  form.append(field('View',choose),allField,list,status,footer);dialog.append(el('h2','',title),form);
  document.body.append(dialog);dialog.showModal();
  let catalogKey='';
  const stop=subscribe(()=>{const key=JSON.stringify(accounts().map(a=>[a.id,a.name]));if(key!==catalogKey){catalogKey=key;draw();}});
  dialog.onclose=()=>{stop();dialog.remove();};
}

export function mountPlans(box,slot,save){
  const prefs=settings(slot);
  box.classList.add('pm-widget');
  const head=el('header','pm-head'),heading=el('h2','','AI Plan Monitor');
  const configure=()=>editPlans(slot,save,{touch:true});
  head.append(heading,button('Accounts',configure));
  const cards=el('div','pm-cards');box.append(head,cards);
  let key='';
  function draw(){
    const now=Date.now(),all=accounts();
    const visible=prefs.mode==='account'?all.filter(a=>a.id===(prefs.pin||all[0]?.id)):all.filter(a=>!prefs.ids||prefs.ids.includes(a.id));
    const version=JSON.stringify([visible,!!snapshot,feedError,Math.floor(now/60000)]);
    if(version===key)return;key=version;
    const focused=cards.contains(document.activeElement)?document.activeElement?.dataset.account:null;
    const scroll=cards.scrollLeft,top=cards.scrollTop;
    cards.replaceChildren();box.dataset.single=String(visible.length===1);
    if(!visible.length)cards.append(el('p','pm-empty','Saved account unavailable on this Mac.'),button('Choose accounts',configure));
    for(const a of visible){
      const card=button('',()=>details(a,prefs.aliases?.[a.id],configure),'pm-card');card.dataset.account=a.id;card.dataset.provider=a.provider;
      card.append(identity(a,prefs.aliases?.[a.id]));
      const live=a.windows.filter(w=>valid(w,now)).sort((a,b)=>b.used-a.used),primary=live[0];
      if(primary){
        const hero=el('div','pm-hero');hero.append(el('strong','',String(remaining(primary))),el('span','','% left'));
        const caption=windowLabel(primary)+(primary.reset?' · resets in '+until(primary.reset,now):'');
        card.append(hero,el('span','pm-caption',caption));
        const meters=el('div','pm-meters');for(const w of [primary,...a.windows.filter(w=>w!==primary)].slice(0,3))meters.append(metric(w,now));card.append(meters);
      }else{
        const pending=!snapshot&&!feedError;
        card.append(el('strong','pm-unavailable',pending?'Checking…':a.windows.length?'Awaiting refresh':'Usage unavailable'),
          el('span','pm-caption',pending?'Reading local accounts':feedError?'Open Dashledge and retry.':a.windows.length?'The last reported window has reset.':guidance(a)));
      }
      card.append(el('span','pm-stamp',readingTime(a,now)));cards.append(card);
      if(focused===a.id)card.focus({preventScroll:true});
    }
    cards.scrollLeft=scroll;cards.scrollTop=top;
  }
  return subscribe(draw);
}
