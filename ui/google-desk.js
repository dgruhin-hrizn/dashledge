import {el,button,invoke,field,select} from './common.js';

const clientKey='edge.desk.mailClient', pinsKey='edge.desk.sparkPins', peopleKey='edge.desk.sparkPeople', enableKey='edge.desk.appleMail', setupKey='edge.google.setup';
const mailClient=()=>localStorage.getItem(clientKey)==='spark'?'Spark':'Apple Mail';
const feeds=new Map(),tiles=new WeakMap();
const date=(d,options)=>new Intl.DateTimeFormat(undefined,options).format(d);
const time=d=>date(d,{hour:'numeric',minute:'2-digit'});
const day=d=>date(d,{weekday:'short',month:'short',day:'numeric'});
export function agendaItems(items,now=new Date(),hidden=new Set()){
  return items.filter(item=>!hidden.has(item.calendarId)).map(item=>{
    const allDay=!!item.start?.date;
    const start=new Date(item.start?.dateTime||item.start?.date+'T00:00:00');
    const end=new Date(item.end?.dateTime||item.end?.date+'T00:00:00');
    return {...item,start,end,allDay};
  }).filter(item=>Number.isFinite(+item.start)&&item.end>now).sort((a,b)=>a.start-b.start);
}
function read(view){
  let feed=feeds.get(view);
  if(!feed){feed={next:0};feeds.set(view,feed)}
  if(!feed.pending&&!feed.requesting&&Date.now()>=feed.next){
    const call=view==='agenda'?invoke('desk_calendar',{request:false}):invoke(view==='spark'?'desk_spark_inbox':'desk_mail');
    feed.pending=call.then(data=>{feed.data=data;feed.error=''}).catch(e=>{feed.error=String(e)}).finally(()=>{
      feed.pending=null;feed.next=Date.now()+(view==='spark'?20000:view==='agenda'&&feed.data?.permission!=='allowed'?5000:60000);feed.updated=Date.now();
    });
  }
  return feed;
}
async function requestCalendar(feed,box){
  if(feed.requesting)return;
  feed.requesting=true;renderGoogle(box);
  try{
    await feed.pending;
    feed.data=await invoke('desk_calendar',{request:true});
    feed.error='';
  }catch(error){feed.error=String(error)}
  finally{
    feed.requesting=false;feed.updated=Date.now();feed.next=Date.now()+(feed.data?.permission==='allowed'?60000:5000);
    if(box.isConnected)renderGoogle(box);
  }
}
function openLink(target,v){invoke('desk_open',{target}).catch(e=>{v.status.textContent=String(e)})}
function action(label,link,v,cls='gd-action'){return button(label,()=>openLink(link,v),cls)}
export function validSparkLink(url){
  return /^readdle-spark:\/\/bl=\S+$/i.test(url)&&url.startsWith('readdle-spark://bl=')&&url.length<8192;
}
function pins(){
  try{return JSON.parse(localStorage.getItem(pinsKey)||'[]').filter(p=>p?.title&&validSparkLink(p.link))}catch{return []}
}
function setup(v,section){
  localStorage.setItem('edge.desk.edit',section||'pins');
  localStorage.setItem(setupKey,String(Date.now()));invoke('open_settings').catch(e=>v.status.textContent=String(e));
}
function people(){
  try{return JSON.parse(localStorage.getItem(peopleKey)||'[]').filter(p=>p.name&&validAddress(p.address))}catch{return []}
}
function validAddress(address){return typeof address==='string'&&address.length<=254&&/^[a-z0-9._+-]+@[a-z0-9.-]+$/i.test(address)}
function mailRow(name,subject,side,click,unread=false){
  const item=button('',click,'gd-mail-row'),who=el('span','gd-mail-avatar');
  who.textContent=name.split(/\s+/).filter(Boolean).slice(0,2).map(s=>Array.from(s)[0]).join('').toUpperCase();
  who.setAttribute('aria-hidden','true');
  const copy=el('span','gd-mail-copy');
  copy.append(el('strong','',name),el('span','',subject));
  item.classList.toggle('gd-unread',unread);
  item.append(who,copy,el('small','gd-mail-side',side));return item;
}
function icon(name){
  const paths={calendar:'M5 5h14v15H5z M5 10h14 M9 3v4 M15 3v4',mail:'M3 5h18v14H3z M3 6l9 7 9-7',swap:'M3 8h16l-4-4 M21 16H5l4 4'};
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),path=document.createElementNS(svg.namespaceURI,'path');
  svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');path.setAttribute('d',paths[name]);svg.append(path);return svg;
}
function pane(kind){
  const root=el('section','gd-pane gd-'+kind),head=el('header','gd-head'),title=el('h2','gd-heading'),tools=el('div','gd-tools'),body=el('div','gd-content'),status=el('div','gd-status');
  title.append(icon(kind),el('span','',kind==='calendar'?'Calendar':'Inbox'));head.append(title,tools);status.setAttribute('role','status');
  root.setAttribute('aria-label',kind==='calendar'?'Calendar':'Mail');root.append(head,body,status);return {root,title,tools,body,status};
}
function note(title,meta,...buttons){
  const n=el('div','gd-note'),actions=el('div','gd-controls');n.append(el('strong','gd-title',title));
  if(meta)n.append(el('span','gd-muted',meta));actions.append(...buttons);n.append(actions);return n;
}
const keyDate=d=>[d.getFullYear(),d.getMonth(),d.getDate()].join('-');
const eventKey=e=>JSON.stringify([e.calendarId||e.calendar,e.summary,+e.start,+e.end]);
function hiddenCalendars(key){
  try{return new Set(JSON.parse(localStorage.getItem(key)||'[]'))}catch{return new Set()}
}
function calendarPicker(v,calendars,hidden,refresh){
  const groups=new Map(),list=el('div','gd-calendar-picker');
  for(const cal of calendars){
    if(!groups.has(cal.accountId))groups.set(cal.accountId,{title:cal.account,items:[]});
    groups.get(cal.accountId).items.push(cal);
  }
  function toggle(ids,show){
    const next=hiddenCalendars(v.filterKey);
    for(const id of ids){if(show)next.delete(id);else next.add(id)}
    localStorage.setItem(v.filterKey,JSON.stringify([...next]));
    v.event=null;refresh();
  }
  for(const group of [...groups.values()].sort((a,b)=>a.title.localeCompare(b.title))){
    const section=el('section','gd-calendar-group'),head=el('div','gd-account-head');
    const shown=group.items.filter(c=>!hidden.has(c.id)).length;
    const hide=shown===group.items.length;
    head.append(el('strong','',group.title),button(hide?'Hide all':'Show all',()=>toggle(group.items.map(c=>c.id),!hide)));
    section.setAttribute('aria-label',group.title);section.append(head);
    for(const cal of group.items.sort((a,b)=>a.title.localeCompare(b.title))){
      const visible=!hidden.has(cal.id);
      const control=button('',()=>toggle([cal.id],!visible),'gd-calendar-choice');
      control.dataset.calendar=cal.id;control.setAttribute('aria-pressed',String(visible));
      const mark=el('span','gd-check',visible?'✓':'');mark.setAttribute('aria-hidden','true');
      control.append(mark,el('span','',cal.title));section.append(control);
    }
    list.append(section);
  }
  if(!groups.size)list.append(note('No calendars on this Mac','Enable Calendars for an account in macOS Internet Accounts.',action('Calendar accounts','accounts',v.calendar)));
  return list;
}
function drawCalendar(v,feed,box,now){
  const p=v.calendar,refresh=()=>{p.sig=null;renderGoogle(box)};
  const filters=localStorage.getItem(v.filterKey);
  const sig=JSON.stringify([filters,v.filterOpen,feed.updated,feed.requesting,v.date,v.event,Math.floor(+now/60000)]);
  if(sig===p.sig&&+now<p.nextEventEnd)return;
  p.sig=sig;p.nextEventEnd=Infinity;
  const offset=p.body.querySelector('.gd-calendar-picker,.gd-list')?.scrollTop||0;
  const focused=document.activeElement?.dataset.calendar;
  v.filterButton.hidden=feed.data?.permission!=='allowed';
  v.filterButton.textContent=v.filterOpen?'Done':'Calendars';
  v.filterButton.setAttribute('aria-expanded',String(!!v.filterOpen));
  p.status.textContent=feed.error||'';p.body.replaceChildren();
  if(!feed.data){p.body.append(note(feed.error?'Calendar unavailable':'Loading calendar…','',
    ...(feed.error?[button('Retry',()=>{feed.next=0;refresh()})]:[])));return}
  if(feed.data.permission!=='allowed'){
    const first=feed.data.permission==='request';
    const allow=button(feed.requesting?'Waiting for macOS…':'Allow calendar access',()=>requestCalendar(feed,box),'gd-primary');allow.disabled=!!feed.requesting;
    p.body.append(note(first?'Connect your calendars':'Calendar access is off',feed.data.detail||'Show upcoming meetings from accounts enabled on this Mac.',
      ...(first?[allow]:[]),action('Calendar permissions','privacy',p)));return;
  }
  const hidden=hiddenCalendars(v.filterKey),calendars=feed.data.calendars||[];
  const excluded=calendars.filter(c=>hidden.has(c.id)).length;
  v.filterButton.classList.toggle('gd-filter-active',excluded>0);
  if(!v.filterOpen&&excluded)v.filterButton.textContent='Calendars · '+(calendars.length-excluded)+'/'+calendars.length;
  if(v.filterOpen){
    const picker=calendarPicker(v,calendars,hidden,refresh);p.body.append(picker);picker.scrollTop=offset;
    if(focused)picker.querySelector('[data-calendar="'+CSS.escape(focused)+'"]')?.focus({preventScroll:true});
    return;
  }
  if(calendars.length&&excluded===calendars.length){
    p.body.append(note('All calendars are hidden','Choose the calendars to show in this widget.',button('Choose calendars',()=>{v.filterOpen=true;refresh()})));return;
  }
  const items=agendaItems(feed.data.items||[],now,hidden),strip=el('div','gd-week');
  for(const event of items)p.nextEventEnd=Math.min(p.nextEventEnd,+event.end);
  if(v.event&&!items.some(event=>eventKey(event)===v.event))v.event=null;
  let selectedDate;
  for(let i=0;i<7;i++){
    const d=new Date(now);d.setHours(0,0,0,0);d.setDate(d.getDate()+i);
    const until=new Date(d);until.setDate(d.getDate()+1);
    const count=items.filter(e=>e.start<until&&e.end>d).length,key=keyDate(d);
    if(v.date===key)selectedDate={d,until};
    const b=button('',()=>{v.date=v.date===key?null:key;v.event=null;refresh()});
    b.setAttribute('aria-label',day(d)+' · '+count+' events');b.setAttribute('aria-pressed',String(v.date===key));
    if(i===0)b.classList.add('gd-today');if(count)b.classList.add('gd-has-events');
    b.append(el('span','',date(d,{weekday:'short'})),el('b','',String(d.getDate())));strip.append(b);
  }
  const events=selectedDate?items.filter(e=>e.start<selectedDate.until&&e.end>selectedDate.d):items;
  const event=events.find(e=>eventKey(e)===v.event)||events.find(e=>!e.allDay)||events[0];
  p.body.append(strip);
  if(!event){p.body.append(note(selectedDate?'No events scheduled':'Calendar is clear',selectedDate?day(selectedDate.d):'Next seven days',
    selectedDate?button('Show week',()=>{v.date=null;refresh()}):action('Calendar accounts','accounts',p)));return}
  const minutes=Math.ceil((event.start-now)/60000);
  const live=!event.allDay&&event.start<=now;
  const focus=el('section','gd-event'),kicker=el('div','gd-eyebrow',event.allDay?'All day':live?'Happening now':minutes<60?'Starts in '+minutes+' min':'Up next');
  const info=[day(event.start),event.allDay?'All day':time(event.start)+' – '+time(event.end),event.calendar,event.location].filter(Boolean);
  focus.append(kicker,el('strong','gd-title',event.summary||'Busy'),el('span','gd-muted',info.join(' · ')));
  const actions=el('div','gd-controls');
  if(event.meeting)actions.append(action('Join meeting',event.meeting,p,'gd-primary'));
  if(v.event||selectedDate)actions.append(button('Show week',()=>{v.event=null;v.date=null;refresh()}));
  if(actions.children.length)focus.append(actions);p.body.append(focus);
  const list=el('div','gd-list gd-agenda');
  for(const e of events.filter(e=>e!==event)){
    const b=button('',()=>{v.event=eventKey(e);refresh()},'gd-agenda-row');
    b.append(el('time','',e.allDay?'All day':time(e.start)),el('strong','',e.summary||'Busy'),el('small','',day(e.start)));list.append(b);
  }
  if(list.children.length)p.body.append(list);list.scrollTop=offset;
}
function drawMail(v,feed,spark,enabled,box,now){
  const p=v.mail,refresh=()=>{p.sig=null;renderGoogle(box)};
  const sig=JSON.stringify([spark,enabled,feed.updated,v.section,v.expanded,localStorage.getItem(pinsKey),localStorage.getItem(peopleKey),keyDate(now)]);
  if(sig===p.sig)return;p.sig=sig;
  const offset=p.body.querySelector('.gd-list')?.scrollTop||0;
  p.status.textContent=feed.error||'';p.body.replaceChildren();p.tools.replaceChildren();p.title.querySelector('.gd-count')?.remove();
  if(!spark&&!enabled){
    p.body.append(note('Choose your mail app','',
      button('Use Apple Mail',()=>{localStorage.setItem(enableKey,'on');refresh()},'gd-primary'),
      button('Use Spark',()=>{localStorage.setItem(clientKey,'spark');refresh()})));return;
  }
  if(feed.data)p.title.append(el('span','gd-count',feed.data.unread+' unread'));
  p.tools.append(action(spark?'Open Spark':'Open Mail',spark?'spark':'apple-mail',p),action('Compose',spark?'compose':'apple-compose',p,'gd-primary'));
  if(spark){
    const tabs=el('div','gd-sections');
    for(const [id,label] of [['recent','Recent'],['pins','Pinned'],['people','Quick compose']]){
      const b=button(label,()=>{v.section=id;refresh()});b.setAttribute('aria-pressed',String(v.section===id));tabs.append(b);
    }
    p.body.append(tabs);
  }
  const list=el('div','gd-list gd-inbox');p.body.append(list);
  if(spark&&v.section==='pins'){
    for(const pin of pins())list.append(mailRow(pin.title,'Spark conversation','↗',()=>openLink(pin.link,p)));
    list.append(button('Manage pinned mail',()=>setup(p,'pins')));return;
  }
  if(spark&&v.section==='people'){
    for(const person of people())list.append(mailRow(person.name,person.address,'↗',()=>openLink('compose-to:'+person.address,p)));
    list.append(button('Edit recipients',()=>setup(p,'people')));return;
  }
  for(const m of feed.data?.items||[]){
    const sender=m.sender.replace(/\s*<[^>]+>$/,'').replace(/^"|"$/g,'')||m.sender;
    const b=mailRow(sender,m.subject,keyDate(new Date(m.received))===keyDate(now)?time(m.received):day(m.received),()=>{
      if(spark){v.expanded=v.expanded===m.id?null:m.id;refresh()}else openLink(m.link,p);
    },m.unread);
    if(spark){
      b.setAttribute('aria-expanded',String(v.expanded===m.id));
      if(v.expanded===m.id)b.append(el('span','gd-mail-detail',m.sender+' · '+day(m.received)+' · '+time(m.received)));
    }
    list.append(b);
  }
  if(!list.children.length)list.append(note(feed.error?'Inbox unavailable':feed.data?'Inbox is clear':'Loading inbox…','',
    ...(feed.error?[button('Retry',()=>{feed.next=0;refresh()})]:[])));
  list.scrollTop=offset;
}
export function renderGoogle(box,slotId){
  let v=tiles.get(box);
  if(!v){
    const shell=el('div','gd-split'),calendar=pane('calendar'),mail=pane('mail');
    const orderKey='edge.desk.order.'+(slotId||'default');
    v={calendar,mail,section:'recent',filterKey:'edge.desk.hiddenCalendars.'+(slotId||'default')};tiles.set(box,v);box.classList.add('gd-tile');
    const order=()=>{
      const mailFirst=localStorage.getItem(orderKey)==='mail';
      const first=mailFirst?mail.root:calendar.root;
      if(shell.firstElementChild!==first)shell.replaceChildren(first,mailFirst?calendar.root:mail.root);
    };
    v.order=order;
    const swap=button('',()=>{localStorage.setItem(orderKey,localStorage.getItem(orderKey)==='mail'?'calendar':'mail');order()},'gd-swap');
    swap.append(icon('swap'));swap.title='Swap mail and calendar';swap.setAttribute('aria-label',swap.title);v.filterButton=button('Calendars',()=>{v.filterOpen=!v.filterOpen;renderGoogle(box)});
    calendar.tools.append(v.filterButton,swap);
    box.replaceChildren(shell);
  }
  v.order();
  const spark=mailClient()==='Spark',enabled=localStorage.getItem(enableKey)==='on',now=new Date();
  drawCalendar(v,read('agenda'),box,now);
  drawMail(v,spark?read('spark'):enabled?read('inbox'):{},spark,enabled,box,now);
}
export function googleSettings(){
  const group=el('div','fields'),msg=el('p','sub'),extra=el('div','fields');
  msg.setAttribute('role','status');
  const picker=select([['Apple Mail','Apple Mail'],['Spark','Spark Desktop']],mailClient(),value=>{
    localStorage.setItem(clientKey,value==='Spark'?'spark':'apple');renderOptions();
  });
  function renderOptions(){
    extra.replaceChildren();msg.textContent='';
    if(mailClient()==='Apple Mail'){
      const on=localStorage.getItem(enableKey)==='on';
      extra.append(button(on?'Disable inbox display':'Enable Apple Mail inbox',()=>{localStorage.setItem(enableKey,on?'off':'on');feeds.delete('inbox');renderOptions()}));return;
    }
    const person=el('input'),address=el('input');address.type='email';person.maxLength=80;
    extra.append(el('h3','','Quick compose'),field('Recipient name',person),field('Email address',address),
      button('Save recipient',()=>{
        const email=address.value.trim(),name=person.value.trim();
        if(!name||!validAddress(email)){msg.textContent='Enter a name and an email address.';return}
        localStorage.setItem(peopleKey,JSON.stringify([...people().filter(p=>p.address.toLowerCase()!==email.toLowerCase()),{name,address:email}]));renderOptions();
      }));
    for(const p of people())extra.append(button('Remove '+p.name,()=>{localStorage.setItem(peopleKey,JSON.stringify(people().filter(i=>i.address!==p.address)));renderOptions()}));
    extra.append(el('h3','','Pinned mail'));
    const name=el('input'),url=el('input');name.maxLength=120;
    const list=pins();
    extra.append(el('p','sub','In Spark, choose Copy Deep Link on a message. Paste it here to pin that conversation.'),
      field('Conversation name',name),field('Spark deep link',url),button('Pin conversation',()=>{
        const link=url.value.trim(),title=name.value.trim();
        if(!title||!validSparkLink(link)){msg.textContent='Enter a name and a private Spark deep link.';return}
        localStorage.setItem(pinsKey,JSON.stringify([{title,link},...pins().filter(p=>p.link!==link)]));renderOptions();
      }));
    const section=localStorage.getItem('edge.desk.edit');
    if(section){localStorage.removeItem('edge.desk.edit');requestAnimationFrame(()=>{(section==='people'?person:name).focus()})}
    for(const p of list)extra.append(button('Remove '+p.title,()=>{localStorage.setItem(pinsKey,JSON.stringify(pins().filter(i=>i.link!==p.link)));renderOptions()}));
  }
  group.append(field('Mail app',picker),extra,msg,el('p','sub','The agenda reads calendars enabled in macOS Internet Accounts. Enable Calendars for the same account you use in Spark.'),
    button('Open Internet Accounts',()=>openLink('accounts',{status:msg})));
  renderOptions();return group;
}
export function takeGoogleSetup(){const at=Number(localStorage.getItem(setupKey));localStorage.removeItem(setupKey);return at>0&&Date.now()-at<30000}
