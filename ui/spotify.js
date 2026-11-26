import {icon,time,crossfade,updateTrackText,lightFromCover,mountDeck} from './music-deck.js';
import {searchSongs,pickDevice,showHistory,artistReleases} from './spotify-browser.js';
import {setQueueRows} from './spotify-queue.js';
import {mountSpectrum} from './spotify-spectrum.js';
import {el, invoke} from './common.js';

function catalogLink(anchor,uri){
  if(anchor.dataset.uri===(uri||''))return;
  anchor.dataset.uri=uri||'';
  const match=/^spotify:(track|episode|artist|album|playlist):([A-Za-z0-9]{22})$/.exec(uri||'');
  if(!match){anchor.removeAttribute('href');anchor.onclick=null;return}
  anchor.href='https://open.spotify.com/'+match[1]+'/'+match[2];
  anchor.title='View on Spotify';
  anchor.onclick=e=>{
    e.preventDefault();
    invoke('spotify_catalog_link',{uri}).catch(error=>{anchor.title=String(error)});
  };
}
const views=new WeakMap();
let player={},sampled=0,nextPlayer=0,busy=false,readVersion=0,reading=false;
let queue={},queueKey='',nextQueue=0,loadingQueue=false,connecting=false;
const clientKey='edge.spotify.client';
const controlKey='edge.spotify.connectControl';
const details=new Map();
let pendingTransport=null;
let generation=0,requested=null,settleUntil=0,queueAfter=0,emptySince=0,refreshUntil=0;
if(typeof window!=='undefined')window.addEventListener('storage',event=>{
  if(event.key==='edge.spotify.authorizedAt'){nextPlayer=0;nextQueue=0;generation++}
});
function cloudControl(){const id=localStorage.getItem(clientKey);return id&&localStorage.getItem(controlKey)===id}
function currentQueueKey(){return JSON.stringify([localStorage.getItem(clientKey),player.context,player.uri,generation])}
function metadata(id,uri){
  if(!id||!uri)return;
  const key=id+'|'+uri,entry=details.get(key);
  if(entry&&Date.now()<entry.expires)return entry.value;
  const next={expires:Infinity,value:entry?.value};
  details.set(key,next);
  invoke('spotify_detail',{clientId:id,uri}).then(value=>{
    next.value=value;next.expires=Date.now()+3600000;
  }).catch(()=>{next.expires=Date.now()+60000});
  return next.value;
}
async function readPlayer(action=0){
  if(action && busy || !action && (reading||busy))return;
  const version=++readVersion;
  if(action)busy=true;else reading=true;
  nextPlayer=Date.now()+(Date.now()<refreshUntil?700:4000);
  try{
    const id=localStorage.getItem(clientKey);
    const enabled=action===4?!player.shuffle:action===5?!player.repeat:!player.playing;
    let value=id?await invoke('spotify_player',{clientId:id,action,enabled}):await invoke('spotify',{action});
    if(version!==readVersion)return;
    if(value.accepted){
      player={...player,error:null};
      if(action===1){
        const now=performance.now();
        if(player.playing)player.position=Math.min(player.duration||0,(player.position||0)+(now-sampled)/1000);
        sampled=now;
        player.playing=enabled;
        pendingTransport={uri:player.uri,playing:enabled,until:Date.now()+3000};
      }else pendingTransport=null;
      refreshUntil=Date.now()+3000;
      nextPlayer=0;nextQueue=0;
      return;
    }
    if(!action&&pendingTransport){
      if(value.uri===pendingTransport.uri&&value.playing!==pendingTransport.playing&&Date.now()<pendingTransport.until){
        nextPlayer=Date.now()+650;return;
      }
      pendingTransport=null;
    }
    if(id&&value.noPlayback){
      const local=await invoke('spotify',{action:0}).catch(()=>null);
      if(version!==readVersion)return;
      if(local?.title){
        // Keep cloud metadata only while the Mac confirms the exact same track.
        const previous=player.uri&&player.uri===local.uri?player:{};
        value={...previous,...local,error:null,noPlayback:true,restricted:!!value.restricted,disallows:null};
      }else if(player.title&&!requested){
        emptySince||=Date.now();
        if(Date.now()-emptySince<6000){
          player={...player,playing:false};
          nextPlayer=Date.now()+900;
          return;
        }
      }
    }
    if(value.title||!value.noPlayback)emptySince=0;
    if(requested&&value.context!==requested.uri&&Date.now()<settleUntil){nextPlayer=Date.now()+700;return}
    if(requested){
      requested=null;
      queueAfter=Date.now()+600;
      nextQueue=0;
    }
    if(action)nextPlayer=Date.now()+600;
    player=value;sampled=performance.now();
  }catch(e){
    if(version===readVersion){
      const error=String(e),expired=error.includes('authorization has expired');
      player={...player,error,expired};
      nextPlayer=expired?Infinity:Date.now()+Number(/Retry in (\d+)/.exec(error)?.[1]||5)*1000;
    }
  }
  finally{if(action)busy=false;else reading=false}
}
async function readQueue(id,key){
  loadingQueue=true;queueKey=key;
  try{
    const result=await invoke('spotify_queue',{clientId:id});
    if(key!==currentQueueKey())return;
    queue=result.retryAfter?{message:'Spotify is busy. Retrying shortly.'}:result;
    nextQueue=Date.now()+(result.retryAfter||(Date.now()<settleUntil||result.current!==player.uri?2:15))*1000;
    if(result.retryAfter)queue.retryUntil=nextQueue;
  }catch(e){if(key===currentQueueKey()){queue={message:String(e),failed:/Reconnect Spotify/i.test(String(e))};nextQueue=Date.now()+Number(/Retry in (\d+)/.exec(String(e))?.[1]||60)*1000}}
  finally{loadingQueue=false}
}
function connect(box,onConnected,permission){
  if(connecting)return;
  const dialog=el('dialog','sp-dialog');
  dialog.innerHTML='<form><h2>Connect Spotify</h2><p>Enter the Client ID from your Spotify Developer Dashboard. Add this redirect URI to the app first.</p><code>http://127.0.0.1:4848/callback</code><label>Spotify Client ID<input required pattern="[a-fA-F0-9]{32}" maxlength="32" autocomplete="off" spellcheck="false"></label><p role="status"></p><footer><button type="button">Close</button><button>Connect Spotify</button></footer></form>';
  const form=dialog.firstChild,input=form.querySelector('input'),status=form.querySelector('[role=status]');
  input.value=localStorage.getItem(clientKey)||'';
  form.querySelector('button').onclick=()=>dialog.close();
  form.onsubmit=async e=>{
    e.preventDefault();
    if(connecting)return;
    connecting=true;form.lastChild.lastChild.disabled=true;input.disabled=true;
    status.textContent='Finish signing in with Spotify in your browser.';
    try{
      const library=permission==='library'||localStorage.getItem('edge.spotify.library')===input.value;
      const history=permission==='history'||localStorage.getItem('edge.spotify.history')===input.value;
      await invoke('spotify_connect',{clientId:input.value,library,history});
      localStorage.setItem(clientKey,input.value);
      localStorage.setItem(controlKey,input.value);
      localStorage.setItem('edge.spotify.authorizedAt',String(Date.now()));
      if(library)localStorage.setItem('edge.spotify.library',input.value);
      if(history)localStorage.setItem('edge.spotify.history',input.value);
      localStorage.setItem('edge.spotify.playlistAccess',input.value);generation++;queue={};nextQueue=0;nextPlayer=0;
      if(dialog.open)dialog.close();
      onConnected?.();
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
function panelApi(box){
  const request=action=>invoke('spotify_panel',{clientId:localStorage.getItem(clientKey),action});
  const refresh=()=>{
    readVersion++;nextPlayer=0;nextQueue=0;refreshUntil=Date.now()+3500;
    if(box.isConnected)renderSpotify(box);
  };
  return {request,refresh,async play(uri){
    await invoke('spotify_play_queue_track',{clientId:localStorage.getItem(clientKey),context:null,tracks:[uri]});
    refresh();
  }};
}
function withAccess(box,permission,run){
  const id=localStorage.getItem(clientKey);
  if(cloudControl()&&(!permission||localStorage.getItem('edge.spotify.'+permission)===id))run();
  else connect(box,run,permission);
}
function showPlaylists(box){
  const dialog=el('dialog','sp-library');
  dialog.setAttribute('aria-label','Your playlists');
  dialog.innerHTML='<header><h2>Your playlists</h2><button aria-label="Close playlists">'+icon('close')+'</button></header><div class="sp-library-scroll"><div class="sp-playlist-grid"></div><div class="sp-library-status" role="status"></div></div>';
  const grid=dialog.querySelector('.sp-playlist-grid'),status=dialog.querySelector('[role=status]');
  const tabs=el('nav','sp-library-tabs'),history=el('div','sp-history');
  const scroll=dialog.querySelector('.sp-library-scroll');
  const playlists=el('button','','Playlists'),recent=el('button','','Recently played');
  function selectHistory(value){
    playlists.setAttribute('aria-pressed',String(!value));recent.setAttribute('aria-pressed',String(value));
    grid.hidden=value;status.hidden=value;history.hidden=!value;
  }
  playlists.onclick=()=>selectHistory(false);
  recent.onclick=()=>withAccess(box,'history',()=>{if(dialog.open){selectHistory(true);showHistory(panelApi(box),dialog,history)}});
  tabs.append(playlists,recent);dialog.insertBefore(tabs,scroll);scroll.append(history);selectHistory(false);
  let starting=false;
  function action(label,callback){
    const button=el('button','sp-connect',label);
    button.onclick=callback;status.append(button);
  }
  function authorize(){
    status.replaceChildren(el('p','','Allow Spotify to share your playlists with this panel.'));
    action('Connect Spotify',()=>connect(box,()=>load(0)));
  }
  async function load(offset){
    const id=localStorage.getItem(clientKey);
    if(!id||localStorage.getItem('edge.spotify.playlistAccess')!==id){authorize();return}
    if(offset===0)grid.replaceChildren();
    status.textContent='Loading playlists…';
    try{
      const page=await invoke('spotify_playlists',{clientId:id,offset});
      if(!dialog.open)return;
      if(page.reconnect){authorize();return}
      status.replaceChildren();
      for(const item of page.items){
        details.set(id+'|'+item.uri,{value:item,expires:Date.now()+3600000});
        const button=el('button','sp-library-item');
        button.setAttribute('aria-label','Play '+item.name);
        const art=el('span','sp-library-cover','♫');
        if(item.art){
          const img=el('img');img.alt='';img.loading='lazy';img.src=item.art;
          img.onerror=()=>img.remove();art.append(img);
        }
        const meta=el('span','sp-qmeta');
        meta.append(el('b','',item.name),el('small','',item.owner||'Playlist'));
        button.append(art,meta);
        const card=el('div','sp-playlist-card'),link=el('a','sp-catalog-action','↗');
        link.setAttribute('aria-label','View '+item.name+' on Spotify');
        catalogLink(link,item.uri);card.append(button,link);grid.append(card);
        const start=async()=>{
          if(starting)return;
          starting=true;
          button.setAttribute('aria-busy','true');
          const owner=meta.lastChild;
          owner.textContent='Starting playback…';
          try{
            await invoke('spotify_play_playlist',{clientId:id,uri:item.uri});
            generation++;readVersion++;requested=item;settleUntil=Date.now()+9000;
            queue={};queueKey='';

            if(dialog.open)dialog.close();
            nextQueue=0;nextPlayer=0;
            if(box.isConnected)renderSpotify(box);
          }catch(e){owner.textContent=String(e);button.title=String(e)}
          finally{button.removeAttribute('aria-busy');starting=false}
        };
        button.onclick=()=>cloudControl()?start():connect(box,start);
      }
      if(page.next!=null)action('Load more playlists',()=>load(page.next));
      else if(!grid.childElementCount)status.textContent='Your Spotify library has no playlists yet.';
    }catch(e){if(/Reconnect Spotify/i.test(String(e)))authorize();else{status.textContent=String(e);action('Try again',()=>load(offset))}}
  }
  dialog.querySelector('header button').onclick=()=>dialog.close();
  dialog.onclose=()=>dialog.remove();document.body.append(dialog);dialog.showModal();load(0);
}
function showArtist(box){
  const {artistUri,artist}=player,id=localStorage.getItem(clientKey);
  if(!artistUri||!id)return;
  const dialog=el('dialog','sp-dialog sp-artist-dialog');
  dialog.setAttribute('aria-label','Artist details');
  const heading=el('h2','',artist),close=el('button','','Close');
  const body=el('div','sp-profile','Loading artist…');
  const link=el('a','sp-artist-link','View artist on Spotify ↗');catalogLink(link,artistUri);
  dialog.append(heading,body,link,close);close.onclick=()=>dialog.close();
  dialog.onclose=()=>dialog.remove();document.body.append(dialog);dialog.showModal();
  const releases=el('div','sp-playlist-grid sp-releases');
  dialog.insertBefore(el('h3','','Albums and singles'),link);dialog.insertBefore(releases,link);
  artistReleases(panelApi(box),dialog,releases,artistUri);
  const cached=metadata(id,artistUri);
  const request=cached?Promise.resolve(cached):invoke('spotify_detail',{clientId:id,uri:artistUri});
  request.then(profile=>{
    if(!dialog.open)return;
    heading.textContent=profile.name||artist;body.replaceChildren();
    if(profile.art){const image=el('img');image.alt=heading.textContent;image.src=profile.art;image.onerror=()=>image.remove();body.append(image)}
    if(profile.genres?.length)body.append(el('p','',profile.genres.join(' · ')));
    if(Number.isFinite(profile.followers))body.append(el('p','',profile.followers.toLocaleString()+' followers'));
    if(!body.childElementCount)body.textContent='Spotify lists no additional details for this artist.';
  }).catch(()=>{body.textContent='Artist details are currently unavailable.'});
}
function create(box){
  mountDeck(box);
  const get=s=>box.querySelector(s),buttons=[];
  for(const [name,action] of [['shuffle',4],['previous',3],['play',1],['next',2],['repeat',5]]){
    const b=el('button','sp-'+name);b.setAttribute('aria-label',name);b.innerHTML=icon(name);
    const control=async()=>{await readPlayer(action);if(box.isConnected)renderSpotify(box)};
    b.onclick=()=>localStorage.getItem(clientKey)&&!cloudControl()?connect(box,control):control();
    buttons.push(b);get('.sp-controls').append(b);
  }
  const visualizer=el('button','sp-vis-open');
  visualizer.setAttribute('aria-label','Open visualizer');visualizer.title='Open visualizer';
  visualizer.innerHTML='<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2 11h3v9H2zm5-6h3v15H7zm5 3h3v12h-3zm5-6h3v18h-3z"/></svg>';
  get('.sp-controls').append(visualizer);
  get('.sp-error button').onclick=()=>connect(box);
  get('.sp-library-toggle').onclick=()=>showPlaylists(box);
  const toggle=get('.sp-toggle');
  function expand(value){box.classList.toggle('sp-expanded',value);toggle.setAttribute('aria-expanded',String(value));}
  toggle.onclick=()=>expand(!box.classList.contains('sp-expanded'));
  get('[aria-label="Close queue"]').onclick=()=>expand(false);
  get('.sp-byline').onclick=()=>withAccess(box,false,()=>showArtist(box));
  const api=panelApi(box);
  get('.sp-add').onclick=()=>withAccess(box,false,()=>{views.get(box).searchSheet=searchSongs(api);paint(box,views.get(box))});
  get('.sp-device').onclick=()=>withAccess(box,false,()=>pickDevice(api));
  const save=get('.sp-save');
  save.onclick=()=>{
    const uri=player.uri;
    withAccess(box,'library',async()=>{
      if(player.uri!==uri||save.dataset.writing)return;
      save.dataset.writing=uri;save.disabled=true;
      try{
        await api.request({kind:'save',uri});
        if(player.uri===uri){save.dataset.saved='true';save.dataset.checked=uri}
      }catch(e){player={...player,error:String(e)}}
      finally{delete save.dataset.writing;paint(box,views.get(box))}
    });
  };
  const seek=get('.sp-seek');
  seek.oninput=()=>{
    seek.dataset.dragging=seek.dataset.dragging||player.uri;
    const fraction=Number(seek.value)/1000;
    get('.sp-track i').style.width=100*fraction+'%';get('.sp-times span').textContent=time(fraction*player.duration);
    seek.setAttribute('aria-valuetext',time(fraction*player.duration));
  };
  seek.onpointercancel=()=>{delete seek.dataset.dragging;renderSpotify(box)};
  seek.onchange=()=>{
    const uri=seek.dataset.dragging||player.uri,seconds=Number(seek.value)*player.duration/1000;
    delete seek.dataset.dragging;
    if(!player.duration||uri!==player.uri)return;
    withAccess(box,false,async()=>{
      if(player.uri!==uri)return;
      try{await api.request({kind:'seek',milliseconds:Math.round(seconds*1000)});
        if(player.uri===uri){player={...player,position:seconds};sampled=performance.now()}
        nextPlayer=Date.now()+700;
      }catch(e){player={...player,error:String(e)}}
      renderSpotify(box);
    });
  };
  buttons[4].onclick=()=>withAccess(box,false,async()=>{
    if(busy)return;
    const mode=player.repeatMode==='context'?'track':player.repeatMode==='track'?'off':'context';
    busy=true;readVersion++;
    try{await api.request({kind:'repeat',mode});player={...player,repeatMode:mode,repeat:mode!=='off',error:null};nextPlayer=Date.now()+800}
    catch(e){player={...player,error:String(e)}}finally{busy=false;renderSpotify(box)}
  });
  const cover=get('.sp-cover');cover.onerror=()=>{cover.hidden=true};
  return {get,buttons,cover,lastQueue:null,spectrum:mountSpectrum(get('.sp-spectrum'),get('.sp-spectrum-status'),box)};
}
export function renderSpotify(box){
  let v=views.get(box);if(!v){v=create(box);views.set(box,v)}
  if(box.closest('[hidden]'))return;
  if(Date.now()>=nextPlayer&&!busy&&!reading)readPlayer().then(()=>{if(box.isConnected)paint(box,v)});
  paint(box,v);
}
function paint(box,v){
  const {get,buttons,cover}=v,d=player,id=localStorage.getItem(clientKey);
  if(v.searchSheet&&!v.searchSheet(d,box.style.getPropertyValue('--sp-light')))v.searchSheet=null;
  const key=currentQueueKey();
  box.dataset.disc=localStorage.getItem('edge.spotify.disc')||'record';
  const context=requested||(d.context?.startsWith('spotify:playlist:')&&metadata(id,d.context));
  const label=get('.sp-context');
  const playlistText=context?.name?'Playlist · '+context.name+(context.owner?' · '+context.owner:''):(d.context?.startsWith('spotify:playlist:')?'Spotify playlist':'');
  if(label.textContent!==playlistText)crossfade(label,()=>{label.textContent=playlistText;label.hidden=!playlistText});
  catalogLink(label,requested?.uri||d.context);catalogLink(get('.sp-brand'),d.uri);
  const artist=metadata(id,d.artistUri),avatar=get('.sp-byline img');
  if(v.portrait!==artist?.art){
    v.portrait=artist?.art;avatar.hidden=!artist?.art;
    if(artist?.art){avatar.onerror=()=>avatar.hidden=true;avatar.src=artist.art}else avatar.removeAttribute('src');
  }
  get('.sp-byline').disabled=!d.artistUri;
  get('.sp-byline').title=d.artistUri?'Artist details':'';

  if(id&&d.uri&&!d.expired&&!requested&&Date.now()>=queueAfter&&!loadingQueue&&Date.now()>=(queue.retryUntil||0)&&(key!==queueKey||Date.now()>=nextQueue)){
    if(key!==queueKey)queue={};
    readQueue(id,key).then(()=>{if(box.isConnected)paint(box,v)});
  }
  const active=Boolean(d.title);
  get('.sp-state').textContent=active?(d.playing?'Now playing':'Paused'):'Player';
  const [title,edition]=titleParts(d.title||(requested?'Starting playlist…':d.noPlayback?'Ready to play':d.status?'Waiting for Spotify':'Finding Spotify…'));
  updateTrackText(get('.sp-title'),title);
  get('.sp-title').title=d.title||'';
  updateTrackText(get('.sp-edition'),edition);
  box.classList.toggle('sp-playing',!!d.playing);
  v.spectrum(!!d.playing);
  updateTrackText(get('.sp-artist'),d.artist||d.status||'');
  const error=get('.sp-error');
  error.hidden=!d.error;
  if(error.firstChild.textContent!==(d.error||''))error.firstChild.textContent=d.error||'';
  error.lastElementChild.hidden=!/Reconnect Spotify/i.test(d.error||'');
  updateTrackText(get('.sp-album'),d.album||'');
  if(v.art!==d.artwork){
    const url=v.art=d.artwork;
    const clearCover=()=>{crossfade(cover,()=>{cover.hidden=true;cover.removeAttribute('src')});box.style.removeProperty('--sp-light')};
    if(url){
      const next=new Image();
      next.src=url;
      next.decode().then(()=>{
        if(v.art!==url||!box.isConnected)return;
        crossfade(cover,()=>{cover.src=url;cover.hidden=false});lightFromCover(box,url,()=>views.get(box)?.art===url);
      }).catch(()=>{if(v.art===url)clearCover()});
    }else clearCover();

  }
  const pos=Math.min(d.duration||0,(d.position||0)+(d.playing?(performance.now()-sampled)/1000:0));
  const seek=get('.sp-seek'),save=get('.sp-save');
  seek.disabled=!d.uri||!d.duration||!!d.restricted||!!d.disallows?.seeking;
  if(!seek.dataset.dragging){
    get('.sp-track i').style.width=(d.duration?100*pos/d.duration:0)+'%';
    seek.value=d.duration?Math.round(pos/d.duration*1000):0;
    get('.sp-times span').textContent=time(pos);seek.setAttribute('aria-valuetext',time(pos));
  }
  get('.sp-device-name').textContent=d.device?.name?'Playing on '+d.device.name:'Playback device';
  get('.sp-device').title=get('.sp-device-name').textContent;
  const track=d.uri?.startsWith('spotify:track:')?d.uri:'';
  const savedKey=[id,track,localStorage.getItem('edge.spotify.library')].join('|');
  if(v.savedKey!==savedKey){
    v.savedKey=savedKey;delete save.dataset.checked;delete save.dataset.saved;
    if(id&&track&&localStorage.getItem('edge.spotify.library')===id){
      panelApi(box).request({kind:'saved',uri:track}).then(result=>{
        if(v.savedKey===savedKey&&!save.dataset.checked&&result[0]){
          save.dataset.saved='true';paint(box,v);
        }
      }).catch(()=>{});
    }
  }
  save.disabled=!track||!!save.dataset.writing||save.dataset.saved==='true';
  save.textContent=save.dataset.saved?'✓':'＋';
  save.setAttribute('aria-label',save.dataset.saved?'Saved to library':'Save song');save.title=save.getAttribute('aria-label');
  get('.sp-times span:last-child').textContent=time(d.duration);
  const restrictions=['toggling_shuffle','skipping_prev',d.playing?'pausing':'resuming','skipping_next','toggling_repeat_context'];
  buttons.forEach((b,i)=>b.disabled=busy||!!d.restricted||d.disallows?.[restrictions[i]]===true||(!active&&!(i===2&&id&&d.noPlayback)));
  const play=d.playing?'pause':'play';
  if(buttons[2].getAttribute('aria-label')!==play){buttons[2].innerHTML=icon(play);buttons[2].setAttribute('aria-label',play)}
  buttons[0].setAttribute('aria-pressed',String(!!d.shuffle));buttons[4].setAttribute('aria-pressed',String(!!d.repeat));
  buttons[4].dataset.mode=d.repeatMode||'off';
  buttons[4].disabled=busy||!!d.restricted||!d.uri||!!d.disallows?.[d.repeatMode==='context'?'toggling_repeat_track':'toggling_repeat_context'];
  buttons[4].title='Repeat: '+(d.repeatMode==='track'?'one track':d.repeatMode==='context'?'playlist or album':'off');
  buttons[4].setAttribute('aria-label',buttons[4].title);
  const mismatch=queueKey!==key||queue.current&&d.uri&&queue.current!==d.uri;
  box.classList.toggle('sp-queued',Boolean(id));
  const list=get('.sp-list');
  const scope=JSON.stringify([id,d.context,generation]);
  const jump=v.jump;
  const landed=jump&&jump.scope===v.queueScope&&jump.uri===d.uri&&Date.now()<jump.until;
  const sameQueue=v.queueScope===scope||landed;
  let consumed=0;
  if(landed){
    consumed=jump.index+1;v.jump=null;
  }else if(sameQueue&&v.queueTrack!==d.uri&&d.uri){
    const index=v.items?.findIndex(item=>item.uri===d.uri)??-1;
    consumed=index+1;
  }
  v.queueScope=scope;v.queueTrack=d.uri;
  const waiting=requested||mismatch||(!queue.items&&!queue.message);
  const items=waiting&&sameQueue?v.items?.slice(consumed):(!waiting?queue.items:null);
  const signature=JSON.stringify([id,scope,items,queue.message,queue.failed,connecting,!!waiting]);
  if(v.lastQueue===signature&&!consumed)return;
  v.lastQueue=signature;v.items=items;
  if(id&&items&&(items.length||waiting)){
    setQueueRows(list,items,index=>jumpToQueueTrack(box,v,index),consumed);
    return;
  }
  if(id&&Array.isArray(items))setQueueRows(list,items,()=>{},consumed);
  else list.replaceChildren();
  if(!id||queue.failed){
    list.append(el('p','',queue.message||'Connect Spotify to see what plays next.'));
    const button=el('button','sp-connect',connecting?'Connecting…':id?'Reconnect Spotify':'Connect Spotify');
    button.disabled=connecting;button.onclick=()=>connect(box);list.append(button);
  }else list.append(el('p','',queue.message||(waiting?'Loading queue…':'Your queue is empty.')));
}

async function jumpToQueueTrack(box,v,index){
  if(busy||requested)return;
  const items=v.items,selected=items?.[index];
  if(!selected)return;
  if(!cloudControl()){
    connect(box,()=>{if(v.items?.[index]?.uri===selected.uri)jumpToQueueTrack(box,v,index)});
    return;
  }
  busy=true;readVersion++;
  const row=v.get('.sp-list').querySelectorAll('.sp-item:not([inert])')[index];
  row?.setAttribute('aria-busy','true');
  try{
    const tracks=items.slice(index).map(item=>item.uri).filter(uri=>/^spotify:track:[A-Za-z0-9]{22}$/.test(uri));
    await invoke('spotify_play_queue_track',{clientId:localStorage.getItem(clientKey),context:player.context||null,tracks});
    v.jump={scope:v.queueScope,uri:selected.uri,index,until:Date.now()+4000};
    player={...player,error:null};pendingTransport=null;
    refreshUntil=Date.now()+4000;nextPlayer=0;nextQueue=0;
  }catch(error){player={...player,error:String(error)}}
  finally{row?.removeAttribute('aria-busy');busy=false;if(box.isConnected)renderSpotify(box)}
}
