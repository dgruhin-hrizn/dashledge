import {openTouchKeyboard} from './search-keyboard.js';
import {el,button} from './common.js';

function sheet(title){
  const dialog=el('dialog','sp-library sp-browser');
  dialog.setAttribute('aria-label',title);
  const head=el('header'),content=el('div','sp-library-scroll');
  head.append(el('h2','',title),button('Close',()=>dialog.close()));
  dialog.append(head,content);
  dialog.onclose=()=>dialog.remove();document.body.append(dialog);dialog.showModal();
  return {dialog,content};
}

function artwork(url){
  const art=el('span','sp-library-cover','♫');
  if(url){const img=el('img');img.alt='';img.loading='lazy';img.src=url;img.onerror=()=>img.remove();art.append(img)}
  return art;
}
function trackRow(track,subtitle,api,dialog,allowQueue){
  const row=el('div','sp-result'),meta=el('div','sp-qmeta');
  meta.append(el('b','',track.name),el('small','',subtitle));
  row.append(artwork(track.album?.images?.[0]?.url),meta);
  const status=el('small','sp-row-status');status.setAttribute('role','status');
  function control(label,name,run){
    const b=button(label,async()=>{
      b.disabled=true;status.textContent='';
      try{await run()}catch(e){status.textContent=String(e)}finally{b.disabled=false}
    });
    b.setAttribute('aria-label',name+' '+track.name);
    if(track.is_playable===false||!track.uri)b.disabled=true;
    row.append(b);return b;
  }
  if(allowQueue)control('+','Add to queue',async()=>{
    await api.request({kind:'enqueue',uri:track.uri});status.textContent='Added to queue';api.refresh();
  });
  control('Play now','Play now',async()=>{await api.play(track.uri);dialog.close()});
  row.append(status);return row;
}

export function searchSongs(api,service='spotify'){
  const apple=service==='applemusic';
  const {dialog,input,content}=openTouchKeyboard({
    title:apple?'Find songs in your library':'Add songs',brand:apple?'Apple Music':'Spotify',
    icon:'widget-icons/'+service+'.svg',placeholder:'Search tracks or artists',
    theme:apple?'apple-music':'',onSubmit:()=>search(true)
  });
  const results=el('div'),status=el('div','sp-library-status');status.setAttribute('role','status');
  const current=el('div','sp-search-current');
  let currentKey;
  function updateCurrent(track,tint){
    if(!dialog.open)return false;
    if(dialog.style.getPropertyValue('--sp-light')!==tint)dialog.style.setProperty('--sp-light',tint);
    const key=JSON.stringify([track.uri,track.title,track.artwork,track.artist,track.playing]);
    if(key===currentKey)return true;
    currentKey=key;current.replaceChildren();
    if(track.title){
      const info=el('div','sp-current-meta');
      info.append(el('small','',track.playing?'Now playing':'Paused'),el('strong','',track.title));
      if(track.artist)info.append(el('span','',track.artist),button('Search artist',()=>{
        input.value=track.artist;input.dispatchEvent(new Event('input',{bubbles:true}));search(true);input.focus();
      }));
      current.append(artwork(track.artwork),info);
    }
    return true;
  }
  content.append(current,results,status);
  let version=0,timer;
  async function load(query,offset,token){
    status.textContent='Searching…';
    try{
      const data=await api.request({kind:'search',query,offset});
      if(!dialog.open||token!==version)return;
      const tracks=data.tracks.items;status.replaceChildren();
      for(const t of tracks)results.append(trackRow(t,t.artists.map(a=>a.name).join(', '),api,dialog,!apple));
      if(data.tracks.next&&tracks.length)status.append(button('More results',()=>load(query,offset+tracks.length,token)));
      if(!results.childElementCount)status.textContent='No matching songs.';
    }catch(e){if(token===version)status.textContent=String(e)}
  }
  function search(immediate){
    const query=input.value.trim(),token=++version;clearTimeout(timer);results.replaceChildren();status.textContent='';
    current.hidden=!!query;content.scrollTop=0;
    if(query){
      if(immediate)load(query,0,token);
      else timer=setTimeout(()=>load(query,0,token),350);
    }
  }
  input.oninput=()=>search(false);
  dialog.addEventListener('close',()=>clearTimeout(timer));input.focus();
  return updateCurrent;
}

export async function showHistory(api,dialog,content){
  content.textContent='Loading listening history…';
  try{
    const data=await api.request({kind:'history'});
    if(!dialog.open||!content.isConnected)return;
    content.replaceChildren();
    for(const {track,played_at} of data.items){
      if(!track?.uri)continue;
      const when=new Date(played_at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
      content.append(trackRow(track,track.artists.map(a=>a.name).join(', ')+' · '+when,api,dialog,false));
    }
    if(!content.childElementCount)content.textContent='Your listening history is empty.';
  }catch(e){content.textContent=String(e)}
}

export async function artistReleases(api,dialog,content,artist,offset=0){
  const status=el('div','sp-library-status','Loading releases…');content.append(status);
  try{
    const data=await api.request({kind:'releases',artist,offset});
    if(!dialog.open)return;
    status.remove();
    for(const album of data.items){
      const b=button('',async()=>{
        b.disabled=true;
        try{await api.request({kind:'play_album',uri:album.uri});api.refresh();dialog.close()}
        catch(e){status.textContent=String(e);content.append(status)}finally{b.disabled=false}
      },'sp-library-item');
      const meta=el('span','sp-qmeta');meta.append(el('b','',album.name),el('small','',[album.album_type,album.release_date?.slice(0,4)].filter(Boolean).join(' · ')));
      b.append(artwork(album.images?.[0]?.url),meta);content.append(b);
    }
    if(data.next&&data.items.length){
      const more=button('More releases',()=>{more.remove();artistReleases(api,dialog,content,artist,offset+data.items.length)});content.append(more);
    }else if(!content.childElementCount)content.textContent='No releases available.';
  }catch(e){status.textContent=String(e)}
}

export function pickDevice(api){
  const {dialog,content}=sheet('Playback device');
  const list=el('div','sp-device-list'),status=el('div','sp-library-status','Finding devices…');
  status.setAttribute('role','status');content.append(list,status);
  let transferring=false;
  function show(devices,active){
    list.replaceChildren();
    for(const d of devices){
      const row=el('div','sp-device-row');
      const isActive=d.id===active&&!!d.id;
      const b=button((isActive?'✓  ':'')+d.name,async()=>{
        if(transferring)return;transferring=true;b.disabled=true;
        try{
          await api.request({kind:'transfer',device:d.id});api.refresh();
          status.textContent='Playback transferred to '+d.name;show(devices,d.id);
        }catch(e){status.textContent=String(e);b.disabled=false}finally{transferring=false}
      });
      b.disabled=isActive||!d.id||d.is_restricted;row.append(b);
      if(isActive&&d.supports_volume&&!d.is_restricted&&Number.isFinite(d.volume_percent)){
        const label=el('label','sp-volume'),value=el('span','', 'Volume '+d.volume_percent+'%');
        const range=el('input');range.type='range';range.min='0';range.max='100';range.value=d.volume_percent;range.dataset.edgeRange='';range.setAttribute('aria-label','Playback volume');
        range.oninput=()=>value.textContent='Volume '+range.value+'%';
        range.onchange=async()=>{
          range.disabled=true;
          try{await api.request({kind:'volume',device:d.id,percent:Number(range.value)});d.volume_percent=Number(range.value)}
          catch(e){status.textContent=String(e);range.value=d.volume_percent;range.oninput()}finally{range.disabled=false}
        };
        label.append(value,range);row.append(label);
      }
      list.append(row);
    }
  }
  api.request({kind:'devices'}).then(data=>{
    if(!dialog.open)return;
    status.textContent=data.devices.length?'':'No Spotify Connect devices are available.';
    show(data.devices,data.devices.find(d=>d.is_active)?.id);
  }).catch(e=>status.textContent=String(e));
}
