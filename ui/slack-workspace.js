import {slackAvatar} from './slack-avatar.js';
import {renderMessage} from './slack-message.js';
import {el,button,invoke} from './common.js';
import {slackTarget} from './slack-catalog.js';
import {previewFeed,previewWorkspace} from './slack-workspace-preview.js';
import {openTouchKeyboard} from './search-keyboard.js';

const panels=new WeakMap();
const time=ts=>new Date(Number(ts)*1000).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
const date=ts=>new Date(Number(ts)*1000).toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'});

export function parentTarget(m){
  let parent=m.thread_ts;
  if(!parent&&m.permalink){try{parent=new URL(m.permalink).searchParams.get('thread_ts')}catch{}}
  return m.channel?.id+'|'+(parent||m.ts);
}
function channelKey(team){return 'edge.slack.workspace.channels.'+team}
function channels(team){
  try{return JSON.parse(localStorage.getItem(channelKey(team))||'[]').filter(x=>typeof x==='string'&&slackTarget('slackchannel',x)).slice(0,16)}catch{return []}
}
function channelDialog(team,choose){
  const {dialog,input,content}=openTouchKeyboard({
    title:'Follow a channel',brand:'Slack',icon:'widget-icons/slack.svg',
    placeholder:'#channel-name',label:'Channel name',maxLength:81,actionLabel:'Follow',
    theme:'sw-keyboard-sheet',onSubmit:submit
  });
  const error=el('p','sw-error');error.setAttribute('role','status');content.append(error);
  input.addEventListener('input',()=>error.textContent='');
  function submit(){
    const name=slackTarget('slackchannel',input.value.toLowerCase());
    if(!name){error.textContent='Enter a Slack channel name.';input.focus();return}
    localStorage.setItem(channelKey(team),JSON.stringify([name,...channels(team).filter(c=>c!==name)].slice(0,16)));
    dialog.close();choose(name);
  }
}
function create(box){
  box.classList.add('sw-tile');
  const shell=el('section','sw-shell'),rail=el('nav','sw-rail'),stream=el('section','sw-stream'),detail=el('section','sw-detail');
  rail.setAttribute('aria-label','Slack navigation');detail.setAttribute('aria-label','Thread');
  const brand=el('div','sw-brand'),logo=el('img');logo.src='widget-icons/slack.svg';logo.alt='';
  brand.append(logo,el('strong','','slack'));const team=el('div','sw-team'),nav=el('div','sw-nav');
  const accountAction=el('div','sw-account-action');rail.append(brand,team,nav,accountAction);
  const heading=el('div','sw-heading'),messages=el('div','sw-messages'),issue=el('p','sw-error');
  issue.setAttribute('role','status');stream.append(heading,issue,messages);
  shell.append(rail,stream,detail);box.replaceChildren(shell);
  return {shell,rail,team,nav,accountAction,heading,messages,issue,detail,kind:'slackmentions',target:'',cursor:'',previous:[]};
}
export function renderWorkspace(box,info,feed){
  let v=panels.get(box);
  if(!v||v.revision!==info?.revision){
    v=create(box);v.revision=info?.revision;panels.set(box,v);
  }
  const connected=info,liveFeed=feed;
  const render=()=>renderWorkspace(box,connected,liveFeed);
  if(!info){
    info=previewWorkspace;feed=previewFeed;
    if(!v.welcome){
      v.welcome=true;
      const connect=button('Connect Slack',()=>{localStorage.setItem('edge.slack.setup','slackworkspace');invoke('open_settings').catch(e=>v.issue.textContent=String(e))},'sw-primary');
      v.accountAction.append(el('span','sw-demo-label','Sample workspace'),connect);
    }
  }
  function select(kind,target=''){
    v.kind=kind;v.target=target;v.followLatest=true;v.selected=null;v.cursor='';v.previous=[];v.showThread=false;v.focused=false;
    v.messages.scrollTop=0;v.detail.scrollTop=0;render();
  }
  const saved=info.preview?['design','studio','launch']:channels(info.teamId);
  const navKey=JSON.stringify([saved,v.kind,v.target]);
  if(navKey!==v.navKey){
    v.navKey=navKey;v.team.textContent=info.team;v.nav.replaceChildren();
    function nav(label,mark,kind,target=''){
      const b=button('',()=>select(kind,target),'sw-nav-btn');b.append(el('span','sw-symbol',mark),el('span','',label));
      b.setAttribute('aria-pressed',String(v.kind===kind&&v.target===target));v.nav.append(b);
    }
    nav('Mentions','@','slackmentions');nav('Direct messages','↗','slackdm');
    const group=el('div','sw-channels');const add=button('+',()=>channelDialog(info.teamId,n=>select('slackchannel',n)));
    add.setAttribute('aria-label','Follow a channel');group.append(el('span','','Channels'));if(!info.preview)group.append(add);v.nav.append(group);
    for(const channel of saved)nav(channel,'#','slackchannel',channel);
  }
  const reading=feed(v.kind,v.target,''),matches=reading.data?.messages?.matches||[];
  const selected=matches.find(m=>m.ts===v.selected?.ts&&m.channel?.id===v.selected?.channel?.id)||v.selected||matches[0];
  v.selected=selected;
  const thread=selected?feed('slackthread',parentTarget(selected),v.cursor):null;
  const chronological=v.kind==='slackchannel';
  const items=chronological?[...matches].sort((a,b)=>Number(a.ts)-Number(b.ts)):matches;
  const label=v.kind==='slackmentions'?'Mentions':v.kind==='slackdm'?'Direct messages':'#'+v.target;
  function openMessage(m){
    if(v.selected?.ts!==m.ts||v.selected?.channel?.id!==m.channel?.id){v.cursor='';v.previous=[]}
    v.selected=m;v.showThread=true;render();
  }
  const listKey=JSON.stringify([v.kind,v.target,reading.version,selected?.ts,selected?.channel?.id]);
  if(listKey!==v.listKey){
    v.listKey=listKey;v.heading.replaceChildren(el('h3','',label));
    if(reading.data)v.heading.append(el('span','sw-count',String(matches.length)));
    if(v.kind==='slackchannel'&&!info.preview){
      const remove=button('Unfollow',()=>{localStorage.setItem(channelKey(info.teamId),JSON.stringify(saved.filter(c=>c!==v.target)));select('slackmentions')},'sw-link');
      v.heading.append(remove);
    }
    v.issue.textContent=reading.error||'';
    const scroll=v.messages.scrollTop;v.messages.replaceChildren();let lastDay='';
    const atBottom=v.followLatest!==false;
    for(const m of items){
      const day=date(m.ts);if(day!==lastDay){v.messages.append(el('div','sw-day',day));lastDay=day}
      const name=m.username||m.user||'Slack',b=button('',()=>openMessage(m),'sw-message');
      const copy=el('span','sw-snippet'),by=el('span','sw-by');
      by.append(el('b','',name),el('small','',time(m.ts)));
      const channel=m.channel?.name;
      if(channel&&!m.channel.is_im&&v.kind==='slackmentions')by.append(el('small','sw-channel','#'+channel));
      const excerpt=el('span','sw-excerpt');excerpt.append(renderMessage(m,{preview:true}));copy.append(by,excerpt);
      b.append(slackAvatar(name,m.avatar),copy);b.setAttribute('aria-pressed',String(m.ts===selected.ts&&m.channel?.id===selected.channel?.id));v.messages.append(b);
    }
    if(!matches.length)v.messages.append(el('p','sw-empty',reading.data?'No recent messages':reading.error?'Feed unavailable':'Loading messages…'));
    v.messages.scrollTop=chronological&&atBottom?v.messages.scrollHeight:scroll;
    v.messages.onscroll=()=>{v.followLatest=v.messages.scrollTop+v.messages.clientHeight>=v.messages.scrollHeight-4};

  }
  v.shell.classList.toggle('sw-thread-open',!!v.showThread);
  v.shell.classList.toggle('sw-focused',!!v.focused);
  const threadKey=JSON.stringify([v.focused,v.kind,v.target,selected?.ts,selected?.channel?.id,reading.version,thread?.version,v.cursor]);
  if(v.threadKey===threadKey)return;v.threadKey=threadKey;
  const sameSelection=v.lastSelection===selected?.ts;v.lastSelection=selected?.ts;
  const offset=sameSelection?v.detail.querySelector('.sw-reading')?.scrollTop||0:0;
  const threadOffset=sameSelection&&v.lastCursor===v.cursor?v.detail.querySelector('.sw-timeline')?.scrollTop||0:0;v.lastCursor=v.cursor;v.detail.replaceChildren();
  if(!selected){v.detail.append(el('p','sw-empty',reading.data?'No conversation selected.':'Waiting for messages…'));return}
  const root=parentTarget(selected).split('|')[1],entries=thread?.data?.messages||[];
  const rootMessage=entries.find(m=>m.ts===root);
  if(rootMessage)v.root={target:parentTarget(selected),message:rootMessage};
  const lead=rootMessage||(v.root?.target===parentTarget(selected)?v.root.message:selected);
  const labelName=m=>m.username||matches.find(x=>x.user===m.user&&x.username)?.username||m.user||'Slack';
  const card=el('article','sw-feature'),by=el('div','sw-by');
  const placement=el('div','sw-location');
  const channel=selected.channel;
  placement.append(el('strong','',channel?.is_im||v.kind==='slackdm'?'Direct message':channel?.name?'# '+channel.name:'Conversation'),
    button('‹ Messages',()=>{v.showThread=false;v.focused=false;render()},'sw-back'));
  by.append(slackAvatar(labelName(lead),lead.avatar),el('b','',labelName(lead)),el('small','',date(lead.ts)+' · '+time(lead.ts)));
  const open=link=>invoke('slack_open',{link}).catch(e=>v.issue.textContent=String(e));
  const body=el('div','sw-reading');body.append(renderMessage(lead,{open}));
  card.append(placement,by,body);
  const controls=el('div','sw-read-controls'),position=items.indexOf(selected);
  const previous=button('‹',()=>openMessage(items[position-1]),'sw-step'),nextMessage=button('›',()=>openMessage(items[position+1]),'sw-step');
  previous.setAttribute('aria-label','Previous message');nextMessage.setAttribute('aria-label','Next message');
  previous.disabled=position<1;nextMessage.disabled=position<0||position+1>=matches.length;
  if(position>=0)controls.append(previous,el('span','sw-position',(position+1)+' / '+matches.length),nextMessage);
  const focus=button(v.focused?'Exit focus':'Focus',()=>{v.focused=!v.focused;v.showThread=true;render()},'sw-focus');
  focus.setAttribute('aria-pressed',String(!!v.focused));controls.append(focus);
  const link=selected.permalink;
  if(link)controls.append(button('Open in Slack ↗',()=>invoke('slack_open',{link}).catch(e=>v.issue.textContent=String(e)),'sw-link'));
  card.append(controls);
  const timeline=el('section','sw-timeline'),top=el('div','sw-thread-head');
  const replies=entries.filter(m=>m.ts!==root);
  top.append(el('h3','','Thread'));if(lead.reply_count!=null)top.append(el('span','sw-count',String(lead.reply_count)));
  timeline.append(top);
  if(thread?.error)timeline.append(el('p','sw-error',thread.error));
  if(replies.length){
    for(const m of replies){
      const r=el('div','sw-reply'),name=labelName(m),line=el('div','sw-reply-by');
      line.append(slackAvatar(name,m.avatar),el('b','',name),el('small','',time(m.ts)));
      r.append(line,renderMessage(m,{open}));timeline.append(r);
    }
  }else if(!thread?.error)timeline.append(el('p','sw-empty',thread?.data?'No replies yet':'Loading replies…'));
  v.detail.append(card);
  const hasThread=replies.length>0||thread?.error||thread?.data?.response_metadata?.next_cursor||v.previous.length;
  v.detail.classList.toggle('sw-solo-reading',!hasThread);
  if(hasThread)v.detail.append(timeline);
  const next=thread?.data?.response_metadata?.next_cursor;
  function move(cursor){v.cursor=cursor;v.detail.scrollTop=0;render()}
  if(v.previous.length)timeline.append(button('‹ Earlier replies',()=>move(v.previous.pop()),'sw-link'));
  if(next)timeline.append(button('More replies ›',()=>{v.previous.push(v.cursor);move(next)},'sw-link'));
  body.scrollTop=offset;timeline.scrollTop=threadOffset;
}
