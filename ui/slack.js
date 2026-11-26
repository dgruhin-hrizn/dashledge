import {slackAvatar} from './slack-avatar.js';
import {messageSummary,renderMessage,slackEmoji} from './slack-message.js';
import {el,button,field,invoke} from './common.js';
import {memberDirectory,memberNames,personalize} from './slack-members.js';
import {renderWorkspace} from './slack-workspace.js';
import {slackWidgets,slackTarget} from './slack-catalog.js';

const accountKey='edge.slack.account',setupKey='edge.slack.setup';
const views=new WeakMap(),feeds=new Map();
let generation,directory;
const messageKinds=new Set(['slackmentions','slackdm','slackchannel','slacksearch','slackthread','slackpins']);
function account(){
  try{return JSON.parse(localStorage.getItem(accountKey))}catch{return null}
}
export function takeSlackSetup(){
  const kind=localStorage.getItem(setupKey);localStorage.removeItem(setupKey);
  return Object.hasOwn(slackWidgets,kind)?kind:'';
}
const scopes=['search:read','pins:read','bookmarks:read','channels:history','groups:history','im:history','mpim:history','users:read','users.profile:read','users.profile:write','dnd:read','dnd:write'];
export function slackSettings(){
  const group=el('div','fields'),token=el('input'),msg=el('p','sub');
  msg.setAttribute('role','status');token.type='password';token.autocomplete='off';token.placeholder='xoxp-…';
  const create=button('Create workspace app ↗',()=>{
    const url=new URL('https://api.slack.com/apps');url.searchParams.set('new_app','1');
    url.searchParams.set('manifest_json',JSON.stringify({display_information:{name:'Dashledge'},oauth_config:{scopes:{user:scopes}}}));
    invoke('slack_open',{link:url.href}).catch(e=>msg.textContent=String(e));
  });
  const connect=button('Connect workspace',()=>save(token.value.trim()));
  const disconnect=button('Disconnect',()=>save(''));
  async function save(value){
    connect.disabled=disconnect.disabled=true;
    try{
      const info=await invoke('slack_connect',{token:value});
      if(info)localStorage.setItem(accountKey,JSON.stringify({...info,revision:Date.now()}));else localStorage.removeItem(accountKey);
      token.value='';msg.textContent=info?'Connected to '+info.team:'Disconnected.';
    }catch(e){msg.textContent=String(e)}finally{connect.disabled=!token.value.trim();disconnect.disabled=!account()}
  }
  connect.disabled=true;disconnect.disabled=!account();token.oninput=()=>connect.disabled=!token.value.trim();
  msg.textContent=account()?'Connected to '+account().team:'';
  group.append(el('p','sub','Create the Slack app from the prefilled manifest, install it to your workspace, then paste the User OAuth Token from OAuth & Permissions. All Slack widgets share this connection.'),create,field('User OAuth Token',token),connect,disconnect,msg);
  return group;
}
const stamp=ts=>ts?new Date(Number(ts)*1000).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'';
function messageLink(info,channel,ts){
  return new URL('/archives/'+encodeURIComponent(channel)+'/p'+String(ts).replace('.',''),info.url||'https://app.slack.com').href;
}
export function rowsFor(kind,data,info,target){
  const message=(m,channel,label)=>({title:messageSummary(m),message:m,author:m.username||m.bot_profile?.name||'Slack member',meta:[label,stamp(m.ts)].filter(Boolean).join(' · '),
    link:m.permalink||messageLink(info,channel,m.ts)});
  switch(kind){
    case 'slackpins':return (data.items||[]).flatMap(i=>i.message?[message(i.message,target,'Pinned message')]:i.file?.permalink?[{title:i.file.title||i.file.name,meta:'Pinned file',link:i.file.permalink}]:[]);
    case 'slackbookmarks':return (data.bookmarks||[]).filter(b=>b.link).map(b=>({title:b.title||b.link,meta:b.link,link:b.link}));
    case 'slackpeople':return (data.members||[]).filter(u=>!u.deleted&&!u.is_bot&&u.id!=='USLACKBOT').map(u=>({title:u.profile?.display_name||u.real_name||u.name,avatar:u.profile?.image_72,meta:u.profile?.title||(u.real_name!==u.profile?.display_name&&u.profile?.display_name?u.real_name:'')||'Direct message',link:'slack://user?team='+encodeURIComponent(info.teamId)+'&id='+encodeURIComponent(u.id)}));
    case 'slackthread':return (data.messages||[]).map(m=>message(m,target.split('|')[0],m.reply_count!=null?'Thread starter':'Reply'));
    default:return (data.messages?.matches||[]).map(m=>message(m,m.channel?.id,m.channel?.name&&!m.channel.is_im&&kind!=='slackchannel'&&kind!=='slackdm'?'#'+m.channel.name:''));
  }
}
function getFeed(kind,target,cursor){
  const key=JSON.stringify([kind,target,cursor]);
  let f=feeds.get(key);
  if(!f){f={next:0,version:0};feeds.set(key,f)}
  if(!f.busy&&Date.now()>=f.next){
    f.busy=true;
    const members=directory;
    invoke('slack_feed',{kind,target,cursor}).then(async data=>{
      f.error='';
      if(!messageKinds.has(kind)){f.data=data;return}
      if(!f.data){f.data=personalize(data,new Map());f.version++}
      const names=await memberNames(data,members);
      f.data=personalize(data,names);
    }).catch(e=>{
      f.error=String(e);
      if(/reconnect|invalid auth/i.test(f.error))delete f.data;
    }).finally(()=>{
      const retry=Number(f.error?.match(/Retry after (\d+)s/)?.[1])||0;
      f.next=Date.now()+1000*Math.max(kind==='slackpeople'?300:60,retry);
      f.version++;f.busy=false;
    });
  }
  return f;
}
function readControl(kind,data){
  if(kind==='slackstatus'){
    const p=data.profile||{};
    return {symbol:p.status_emoji?slackEmoji(p.status_emoji.replace(/^:|:$/g,'')):null,title:p.status_text||(p.status_emoji?'Status set':'No status set'),meta:p.status_expiration?'Clears '+stamp(p.status_expiration):'Your workspace status',
      actions:[['meeting','Meeting · 1h'],['focus','Focus · 1h'],['lunch','Lunch · 30m'],...(p.status_text||p.status_emoji?[['clear','Clear status']]:[])]};
  }
  const now=Date.now()/1000,scheduled=data.dnd_enabled&&data.next_dnd_start_ts<=now&&data.next_dnd_end_ts>now;
  return {title:data.snooze_enabled?'Snoozed':scheduled?'Quiet hours':'Available',
    meta:data.snooze_enabled?'Notifications paused until '+stamp(data.snooze_endtime):scheduled?'Scheduled until '+stamp(data.next_dnd_end_ts):'Slack notifications are on',
    actions:data.snooze_enabled?[['resume','End snooze']]:[['30','30 min'],['60','1 hour'],['120','2 hours']]};
}
export function renderSlack(box,slot){
  const {kind}=slot,w=slackWidgets[kind],info=account(),target=slackTarget(kind,slot.slackTarget);
  if(!directory||generation!==info?.revision){
    directory?.stop();feeds.clear();generation=info?.revision;
    directory=memberDirectory(id=>invoke('slack_feed',{kind:'slackmember',target:id,cursor:''}));
  }
  if(kind==='slackworkspace'){renderWorkspace(box,info,getFeed);return}
  let v=views.get(box);
  if(!v){
    box.classList.add('slack-tile');box.dataset.slack=kind;
    const shell=el('section','sl-shell'),head=el('div','sl-head'),logo=el('img');logo.src='widget-icons/slack.svg';logo.alt='Slack';
    const team=el('span','sl-team'),body=el('div','sl-body'),note=el('div','sl-note');
    note.setAttribute('role','status');head.append(logo,el('strong','',w.name),team);
    shell.append(head,body,note);box.replaceChildren(shell);
    v={body,note,team,cursor:'',previous:[]};views.set(box,v);
  }
  if(v.account!==info?.revision){v.cursor='';v.previous=[];v.account=info?.revision;v.feedback=''}
  const ready=info&&(!w.field||target),f=ready?getFeed(kind,target,v.cursor):null;
  const sig=JSON.stringify([info?.revision,target,v.cursor,f?.version,v.acting,v.feedback]);
  if(v.sig===sig)return;v.sig=sig;v.team.textContent=info&&target&&kind==='slackchannel'?'#'+target:info&&target&&kind==='slacksearch'?target:info?.team||'Slack';
  const offset=v.body.scrollTop;v.body.replaceChildren();v.note.textContent=v.feedback||((f?.data&&f.error?'Last sync · ':'')+(f?.error||''));
  function hero(title,meta,symbol=w.symbol){
    const h=el('div','sl-hero'),mark=el('div','sl-mark',symbol);mark.setAttribute('aria-hidden','true');
    const copy=el('div','sl-copy');copy.append(el('h3','',title),el('p','',meta));h.append(mark,copy);v.body.append(h);
  }
  if(!info){
    hero(w.name,w.description);
    v.body.append(button('Connect Slack',()=>{localStorage.setItem(setupKey,kind);invoke('open_settings').catch(e=>v.note.textContent=String(e))},'sl-action'));return;
  }
  if(!ready){hero(w.name,'Choose this tile in Pages & layouts to set its '+w.field.toLowerCase()+'.');return}
  if(!f.data){hero(f.error?'Sync paused':'Connecting…',w.name);return}
  if(['slacksnooze','slackstatus'].includes(kind)){
    const control=readControl(kind,f.data);hero(control.title,control.meta,control.symbol||w.symbol);
    const actions=el('div','sl-actions');
    for(const [action,label] of control.actions){
      const b=button(label,async()=>{
        if(v.acting)return;v.acting=true;v.feedback='Updating…';renderSlack(box,slot);
        try{await invoke('slack_control',{action});feeds.delete(JSON.stringify([kind,target,'']));v.feedback=''}
        catch(e){v.feedback=String(e)}finally{v.acting=false;renderSlack(box,slot)}
      },'sl-action');b.disabled=!!v.acting;actions.append(b);
    }
    v.body.append(actions);return;
  }
  const rows=rowsFor(kind,f.data,info,target);
  if(kind==='slackthread'&&!v.cursor&&f.data.messages?.length){
    const parent=f.data.messages[0],count=parent.reply_count||0;
    const summary=el('div','sl-thread-summary');
    summary.append(el('strong','',count+' '+(count===1?'reply':'replies')),el('span','',parent.latest_reply?'Latest '+stamp(parent.latest_reply):'Thread activity'));
    v.body.append(summary);
  }
  const list=el('div','sl-list');
  for(const row of rows){
    const b=button('',()=>invoke('slack_open',{link:row.link}).catch(e=>v.note.textContent=String(e)),'sl-row');
    const copy=el('span','sl-row-copy');
    if(row.message){
      const by=el('span','sl-row-by');by.append(el('strong','',row.author),el('small','',row.meta));
      const excerpt=el('span','sl-row-excerpt');excerpt.append(renderMessage(row.message,{preview:true}));
      copy.append(by,excerpt);b.append(slackAvatar(row.author,row.message.avatar));
    }else{
      copy.append(el('strong','',row.title),el('small','',row.meta));
      if(kind==='slackpeople')b.append(slackAvatar(row.title,row.avatar));
      else b.append(el('span','sl-resource-icon',w.symbol));
    }
    b.append(copy,el('span','sl-arrow','↗'));list.append(b);
  }
  if(rows.length)v.body.append(list);else hero('Nothing here yet',w.field?slot.slackTarget:w.name);
  const next=f.data.response_metadata?.next_cursor;
  if(next||v.previous.length){
    const pager=el('div','sl-actions');
    function move(cursor){v.cursor=cursor;v.body.scrollTop=0;renderSlack(box,slot)}
    if(v.previous.length)pager.append(button('‹ Previous',()=>move(v.previous.pop()),'sl-action'));
    if(next)pager.append(button('Next ›',()=>{v.previous.push(v.cursor);move(next)},'sl-action'));
    v.body.append(pager);
  }
  v.body.scrollTop=offset;
}
