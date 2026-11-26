import {el, invoke} from './common.js';

const paths = {
  previous:'M6 5v14M19 5l-10 7 10 7z', next:'M18 5v14M5 5l10 7-10 7z',
  play:'M7 4.5v15l12-7.5z', pause:'M7 5h3v14H7z M14 5h3v14h-3z',
  shuffle:'M3 6h2c5 0 8 12 13 12h3m-3-3 3 3-3 3M3 18h2c2 0 4-2 5-4m4-5c1-2 3-3 5-3h2m-3-3 3 3-3 3',
  repeat:'M4 11V9a3 3 0 0 1 3-3h13m-3-3 3 3-3 3M20 13v2a3 3 0 0 1-3 3H4m3-3-3 3 3 3',
  queue:'M3 5h17M3 11h13M3 17h7m5-3 5 3-5 3z', close:'m6 6 12 12M18 6 6 18'
};
function icon(name){
  const filled=['play','pause','next','previous'].includes(name);
  return '<svg aria-hidden="true" viewBox="0 0 24 24" fill="'+(filled?'currentColor':'none')+'" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="'+paths[name]+'"/></svg>';
}
function time(seconds){
  const s=Math.max(0,Math.floor(seconds||0));
  return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
}
const views=new WeakMap();
let player={},sampled=0,nextPlayer=0,busy=false,readVersion=0,reading=false;
let queue={},queueKey='',nextQueue=0,loadingQueue=false,connecting=false;
const clientKey='edge.spotify.client';
async function readPlayer(action=0){
  if(action && busy || !action && (reading||busy))return;
  const version=++readVersion;
  if(action)busy=true;else reading=true;
  nextPlayer=Date.now()+4000;
  try{
    const value=await invoke('spotify',{action});
    if(version===readVersion){player=value;sampled=performance.now()}
  }catch(e){if(version===readVersion)player={status:String(e)}}
  finally{if(action)busy=false;else reading=false}
}
async function readQueue(id,key){
  loadingQueue=true;queueKey=key;
  try{
    const result=await invoke('spotify_queue',{clientId:id});
    queue=result.retryAfter?{message:'Spotify is busy. Retrying shortly.'}:result;
    nextQueue=Date.now()+(result.retryAfter||30)*1000;
    if(result.retryAfter)queue.retryUntil=nextQueue;
  }catch(e){queue={message:String(e),failed:true};nextQueue=Date.now()+60000}
  finally{loadingQueue=false}
}
function connect(box){
  if(connecting)return;
  const dialog=el('dialog','sp-dialog');
  dialog.innerHTML='<form><h2>Connect Up Next</h2><p>Enter the Client ID from your Spotify Developer Dashboard. Add this redirect URI to the app first.</p><code>http://127.0.0.1:4848/callback</code><label>Spotify Client ID<input required pattern="[a-fA-F0-9]{32}" maxlength="32" autocomplete="off" spellcheck="false"></label><p role="status"></p><footer><button type="button">Close</button><button>Connect Spotify</button></footer></form>';
  const form=dialog.firstChild,input=form.querySelector('input'),status=form.querySelector('[role=status]');
  input.value=localStorage.getItem(clientKey)||'';
  form.querySelector('button').onclick=()=>dialog.close();
  form.onsubmit=async e=>{
    e.preventDefault();
    if(connecting)return;
    connecting=true;form.lastChild.lastChild.disabled=true;input.disabled=true;
    status.textContent='Finish signing in with Spotify in your browser.';
    try{
      await invoke('spotify_connect',{clientId:input.value});
      localStorage.setItem(clientKey,input.value);queue={};nextQueue=0;
      if(dialog.open)dialog.close();
    }catch(e){status.textContent=String(e);queue={message:String(e),failed:true}}
    finally{connecting=false;form.lastChild.lastChild.disabled=false;input.disabled=false;if(box.isConnected)renderSpotify(box)}
  };
  dialog.onclose=()=>dialog.remove();document.body.append(dialog);dialog.showModal();
}
// Keep edition qualifiers visible while giving the song name typographic priority.
function titleParts(title){
  const match=title.match(/^(.+?)\s+[-–—]\s+((?:\d{4}\s+)?(?:remaster(?:ed)?|radio edit|deluxe edition|anniversary edition)\b.*)$/i);
  return match ? [match[1],match[2]] : [title,''];
}
function create(box){
  box.classList.add('sp-tile');
  box.innerHTML=`<div class="sp-shell">
    <div class="sp-head"><div class="sp-brand"><img src="widget-icons/spotify.svg" alt="">Spotify</div><button class="sp-toggle" aria-expanded="false">${icon('queue')} Up next</button></div>
    <div class="sp-layout"><div class="sp-deck"><button class="sp-sleeve" aria-label="Open in Spotify" title="Open in Spotify"><span class="sp-record"></span><img class="sp-cover" hidden alt=""></button>
    <div class="sp-info"><div class="sp-eyebrow"><span class="sp-meter" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span class="sp-state"></span></div><strong class="sp-title"></strong><div class="sp-artist"></div><div class="sp-details"><span class="sp-album"></span><span class="sp-edition"></span></div>
    <div class="sp-timeline"><div class="sp-track"><i></i></div><div class="sp-times"><span></span><span></span></div></div>
    <div class="sp-controls"></div></div></div>
    <section class="sp-queue"><div class="sp-qhead"><b>Up next</b><button aria-label="Close queue">${icon('close')}</button></div><div class="sp-list"></div></section></div></div>`;
  const get=s=>box.querySelector(s),buttons=[];
  for(const [name,action] of [['shuffle',4],['previous',3],['play',1],['next',2],['repeat',5]]){
    const b=el('button','sp-'+name);b.setAttribute('aria-label',name);b.innerHTML=icon(name);
    b.onclick=async()=>{await readPlayer(action);if(box.isConnected)renderSpotify(box)};
    buttons.push(b);get('.sp-controls').append(b);
  }
  const toggle=get('.sp-toggle');
  function expand(value){box.classList.toggle('sp-expanded',value);toggle.setAttribute('aria-expanded',String(value));}
  toggle.onclick=()=>expand(!box.classList.contains('sp-expanded'));
  get('.sp-qhead button').onclick=()=>expand(false);
  get('.sp-sleeve').onclick=async()=>{
    try{await invoke('spotify_open',{uri:player.uri||null});nextPlayer=0}
    catch(e){player={status:String(e)}}
    if(box.isConnected)renderSpotify(box);
  };
  const cover=get('.sp-cover');cover.onerror=()=>{cover.hidden=true};
  return {get,buttons,cover,lastQueue:null};
}
export function renderSpotify(box){
  let v=views.get(box);if(!v){v=create(box);views.set(box,v)}
  if(box.closest('[hidden]'))return;
  if(Date.now()>=nextPlayer&&!busy&&!reading)readPlayer().then(()=>{if(box.isConnected)paint(box,v)});
  paint(box,v);
}
function paint(box,v){
  const {get,buttons,cover}=v,d=player,id=localStorage.getItem(clientKey);
  const key=id+'|'+(d.uri||d.title||'');
  if(id&&!loadingQueue&&Date.now()>=(queue.retryUntil||0)&&(key!==queueKey||Date.now()>=nextQueue)){
    if(key!==queueKey)queue={};
    readQueue(id,key).then(()=>{if(box.isConnected)paint(box,v)});
  }
  const active=Boolean(d.title);
  get('.sp-state').textContent=active?(d.playing?'Now playing':'Paused'):'Player';
  const [title,edition]=titleParts(d.title||(d.status?'Spotify is idle':'Finding Spotify…'));
  get('.sp-title').textContent=title;
  get('.sp-title').title=d.title||'';
  get('.sp-edition').textContent=edition;
  box.classList.toggle('sp-playing',!!d.playing);
  get('.sp-artist').textContent=d.artist||d.status||'';
  get('.sp-album').textContent=d.album||'';
  if(v.art!==d.artwork){
    v.art=d.artwork;cover.hidden=!d.artwork;
    if(d.artwork)cover.src=d.artwork;else cover.removeAttribute('src');
  }
  const pos=Math.min(d.duration||0,(d.position||0)+(d.playing?(performance.now()-sampled)/1000:0));
  get('.sp-track i').style.width=(d.duration?100*pos/d.duration:0)+'%';
  get('.sp-times span').textContent=time(pos);get('.sp-times span:last-child').textContent=time(d.duration);
  buttons.forEach(b=>b.disabled=!active||busy);
  const play=d.playing?'pause':'play';
  if(buttons[2].getAttribute('aria-label')!==play){buttons[2].innerHTML=icon(play);buttons[2].setAttribute('aria-label',play)}
  buttons[0].setAttribute('aria-pressed',String(!!d.shuffle));buttons[4].setAttribute('aria-pressed',String(!!d.repeat));
  const mismatch=queue.current&&d.uri&&queue.current!==d.uri;
  box.classList.toggle('sp-queued',Boolean(id&&!mismatch&&queue.items?.length));
  const signature=JSON.stringify([id,queue,connecting,mismatch]);
  if(v.lastQueue===signature)return;
  v.lastQueue=signature;
  const list=get('.sp-list');list.replaceChildren();
  if(!id||queue.failed){
    list.append(el('p','',queue.message||'Connect Spotify to see what plays next.'));
    const button=el('button','sp-connect',connecting?'Connecting…':id?'Reconnect Spotify':'Connect Spotify');
    button.disabled=connecting;button.onclick=()=>connect(box);list.append(button);
  }else if(!mismatch&&queue.items?.length){
    queue.items.forEach((item,i)=>{
      const row=el('div','sp-item'),meta=el('div','sp-qmeta');
      row.append(el('span','sp-index',String(i+1).padStart(2,'0')));
      if(item.art){const img=el('img');img.alt='';img.src=item.art;img.loading='lazy';img.onerror=()=>img.hidden=true;row.append(img)}
      meta.append(el('b','',item.title||'Unavailable item'),el('small','',item.artist||''));row.append(meta);list.append(row);
    });
  }else list.append(el('p','',queue.message||(mismatch?'Spotify is playing on another device.':queue.items?'Your queue is empty.':'Loading queue…')));
}
