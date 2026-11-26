import {showMusicPlaylists} from './apple-music-playlists.js';
import {albumImages,artistImage,albumTracks,followingAlbumTracks} from './apple-music-art.js';
import {soundControls,songInfo} from './apple-music-tools.js';
import {el,button,invoke} from './common.js';
import {icon,time,crossfade,updateTrackText,lightFromCover,mountDeck} from './music-deck.js';
import {mountSpectrum} from './spotify-spectrum.js';
import {searchSongs} from './spotify-browser.js';
import {setQueueRows} from './spotify-queue.js';

const views=new WeakMap();
const request=(action,value='',known='')=>invoke('apple_music',{action,value:String(value),known:String(known)});

function sheet(title){
  const dialog=el('dialog','sp-library apple-music'),head=el('header'),body=el('div','sp-library-scroll');
  head.append(el('h2','',title),button('Close',()=>dialog.close()));
  dialog.append(head,body);dialog.setAttribute('aria-label',title);
  dialog.onclose=()=>dialog.remove();document.body.append(dialog);dialog.showModal();
  return {dialog,body};
}

function mount(box){
  mountDeck(box,'applemusic');box.classList.add('apple-music','sp-queued');
  const get=selector=>box.querySelector(selector);
  const v={player:{},next:0,reading:false,writing:false,revision:0,sampled:performance.now()};
  const portrait=get('.sp-byline img'),sleeve=get('.sp-cover');
  function updateImages(d){
    const artist=d.artist||'',release=JSON.stringify([artist,d.album||'']);
    if(v.artist!==artist){v.artist=artist;portrait.hidden=true;portrait.removeAttribute('src')}
    if(v.release!==release){
      v.release=release;v.catalogCover='';v.smallCover='';
      if(artist)albumImages(request,artist,d.album||'').then(async images=>{
        if(v.release!==release||!box.isConnected)return;
        v.smallCover=images.cover||'';
        v.catalogCover=v.smallCover.replace(/100x100bb(?=\.)/,'600x600bb');
        paint();
        if(!images.artistId)return;
        const {portrait:url}=await artistImage(request,images.artistId);
        if(v.artist===artist&&box.isConnected&&url){portrait.onerror=()=>portrait.hidden=true;portrait.src=url;portrait.hidden=false}
      });
    }
    const url=d.artwork||v.catalogCover||'';
    if(v.art===url)return;
    v.art=url;
    function apply(src){
      if(v.art!==url||!box.isConnected)return;
      crossfade(sleeve,()=>{if(src)sleeve.src=src;else sleeve.removeAttribute('src');sleeve.hidden=!src});
      lightFromCover(box,src,()=>v.art===url);
    }
    if(!url){apply('');return}
    const image=new Image();
    image.onload=()=>apply(image.src);
    image.onerror=()=>{
      if(v.art!==url)return;
      if(v.smallCover&&image.src!==v.smallCover){image.src=v.smallCover;return}
      apply('');
    };
    image.src=url;
  }
  const error=text=>{get('.sp-error span').textContent=text;get('.sp-error').hidden=!text};
  async function control(action,value,known){
    if(v.writing)return false;
    v.writing=true;v.revision++;error('');
    try{await request(action,value,known);return true}
    catch(e){error(String(e));return false}
    finally{v.writing=false;v.next=0;if(box.isConnected)v.tick()}
  }
  const controls={};
  for(const name of ['shuffle','previous','play','next','repeat']){
    const b=button('',()=>control(name==='play'&&v.player.playing?'pause':name),'sp-'+name);
    b.innerHTML=icon(name);b.setAttribute('aria-label',name);controls[name]=b;get('.sp-controls').append(b);
  }
  const vis=button('',null,'sp-vis-open');vis.innerHTML='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M2 11h3v9H2zm5-6h3v15H7zm5 3h3v12h-3zm5-6h3v18h-3z"/></svg>';
  vis.setAttribute('aria-label','Open visualizer');get('.sp-controls').append(vis);
  const spectrum=mountSpectrum(get('.sp-spectrum'),get('.sp-spectrum-status'),box,'applemusic');
  function expand(value){box.classList.toggle('sp-expanded',value);get('.sp-toggle').setAttribute('aria-expanded',String(value))}
  get('.sp-toggle').onclick=()=>expand(!box.classList.contains('sp-expanded'));
  get('[aria-label="Close queue"]').onclick=()=>expand(false);
  get('.sp-save').onclick=()=>control('favorite');
  get('.sp-add').onclick=()=>{
    v.search=searchSongs({
      async request({query}){
        const rows=await request('search',query);
        return {tracks:{items:rows.map(row=>({name:row.title,uri:row.uri,artists:[{name:row.artist}]}))}};
      },
      async play(uri){if(!await control('track',uri))throw Error(get('.sp-error span').textContent||'Playback is busy.')}
    },'applemusic');paint();
  };
  get('.sp-library-toggle').onclick=()=>showMusicPlaylists(request,async playlist=>{
    if(!await control('playlist',playlist.id,playlist.key))throw Error(get('.sp-error span').textContent||'Playback is busy.');
  });
  get('.sp-device-name').textContent='Sound & outputs';
  get('.sp-device').setAttribute('aria-label','Sound & outputs');
  get('.sp-device').onclick=()=>soundControls(sheet,request,()=>{v.next=0;v.tick()});
  const info=button('Song info',()=>songInfo(sheet,request),'sp-library-toggle');get('.sp-head').append(info);
  get('.sp-byline').onclick=async()=>{
    const artist=v.player.artist;
    const {dialog,body}=sheet(artist);body.textContent='Finding songs in your library…';
    try{
      const rows=(await request('search',artist)).filter(t=>t.artist.toLocaleLowerCase()===artist.toLocaleLowerCase());
      body.replaceChildren();
      if(v.artist===artist&&!portrait.hidden){const photo=portrait.cloneNode();photo.className='am-artist-photo';body.append(photo)}
      const status=el('p','sp-library-status',rows.length?'':'No matching songs in your library.');
      for(const row of rows)body.append(button(row.title,async()=>{
        if(await control('track',row.uri))dialog.close();else status.textContent=get('.sp-error span').textContent;
      },'sp-library-item'));
      body.append(status);
    }catch(e){body.textContent=String(e)}
  };
  const seek=get('.sp-seek');
  function timeline(pos){
    const length=v.player.duration||0,progress=length?Math.min(1000,Math.round(1000*pos/length)):0;
    get('.sp-track i').style.width=progress/10+'%';get('.sp-times span').textContent=time(pos);
    seek.setAttribute('aria-valuetext',time(pos));if(!v.drag)seek.value=progress;
  }
  seek.oninput=()=>{v.drag=v.player.key;timeline(v.player.duration*seek.value/1000)};
  seek.onpointercancel=()=>{v.drag=null;paint()};
  seek.onchange=()=>{const key=v.drag||v.player.key;v.drag=null;if(key===v.player.key)control('seek',v.player.duration*seek.value/1000)};
  function paint(){
    const d=v.player,active=!!d.title;
    box.dataset.disc=localStorage.getItem('edge.applemusic.disc')||'record';
    box.classList.toggle('sp-playing',!!d.playing);get('.sp-state').textContent=active?(d.playing?'Now playing':'Paused'):'Apple Music';
    updateTrackText(get('.sp-title'),d.title||'Ready to play');
    updateTrackText(get('.sp-artist'),d.artist||'');updateTrackText(get('.sp-album'),d.album||'');
    get('.sp-byline').disabled=!d.artist;get('.sp-byline').title=d.artist?'Songs by '+d.artist+' in your library':'';
    const label=get('.sp-context');label.hidden=!d.playlist;label.textContent=d.playlist?'Playlist · '+d.playlist:'';
    updateImages(d);
    for(const [name,b] of Object.entries(controls))b.disabled=v.writing||(!active&&name!=='play');
    const command=d.playing?'pause':'play';
    if(controls.play.getAttribute('aria-label')!==command){controls.play.innerHTML=icon(command);controls.play.setAttribute('aria-label',command)}
    controls.shuffle.setAttribute('aria-pressed',String(!!d.shuffle));
    controls.repeat.setAttribute('aria-pressed',String(!!d.repeat&&d.repeat!=='off'));controls.repeat.dataset.mode=d.repeat||'off';
    controls.repeat.setAttribute('aria-label','Repeat '+(d.repeat||'off'));
    const fav=get('.sp-save');fav.textContent=d.favorite?'♥':'♡';fav.disabled=!active;
    fav.setAttribute('aria-pressed',String(!!d.favorite));fav.title=d.favorite?'Remove favorite':'Favorite song';fav.setAttribute('aria-label',fav.title);
    info.disabled=!active;seek.disabled=!d.duration;
    if(!v.drag)timeline(Math.min(d.duration||0,(d.position||0)+(d.playing?(performance.now()-v.sampled)/1000:0)));
    get('.sp-times span:last-child').textContent=time(d.duration);
    if(v.displayed!==d.key||!v.queueInitialized){
      v.queueInitialized=true;v.displayed=d.key;const rows=d.up||[],list=get('.sp-list');
      const heading=d.albumOrder?'Next on album':'Next in playlist';
      get('.sp-qhead b').textContent=heading;get('.sp-toggle').lastChild.textContent=' '+heading;
      function render(items,command,empty){
        setQueueRows(list,items,i=>control(command,items[i].uri),0,id=>/^[1-9]\d*$/.test(id));
        if(!items.length)list.append(el('p','sp-library-status',empty));
      }
      if(d.albumOrder&&!d.shuffle&&d.repeat!=='track'){
        render([],'track','Loading album tracks…');
        albumTracks(request,d).then(tracks=>{
          if(!box.isConnected||v.player.key!==d.key)return;
          const next=followingAlbumTracks(tracks,d);
          render(next||[],'track',next?'End of album.':'Album order unavailable.');
        });
      }else render(rows,'up',d.shuffle?'Shuffle is on.':d.repeat==='track'?'Repeating this song.':'No upcoming playlist tracks.');
    }
    if(v.search&&!v.search({...d,artwork:d.artwork||v.catalogCover},box.style.getPropertyValue('--sp-light')))v.search=null;
    spectrum(!!d.playing);
  }
  v.tick=()=>{
    if(box.closest('[hidden]')||document.hidden)return;
    paint();
    if(v.reading||v.writing||Date.now()<v.next)return;
    v.reading=true;const revision=v.revision;
    const retryCover=v.player.key&&!v.player.artwork&&!v.catalogCover&&v.retries<2&&Date.now()>=v.retryAt;
    if(retryCover){v.retries++;v.retryAt=Date.now()+15000}
    request('state','',retryCover?'':v.player.key||'').then(d=>{
      if(revision!==v.revision||!box.isConnected)return;
      if(v.player.key!==d.key){v.retries=0;v.retryAt=Date.now()+5000}
      v.player=d.key&&d.key===v.player.key?{...v.player,...d}:d;v.sampled=performance.now();v.next=Date.now()+1800;
      if(v.readError){error('');v.readError=false}paint();
    }).catch(e=>{v.readError=true;error(String(e));v.next=Date.now()+15000}).finally(()=>{v.reading=false});
  };
  return v;
}

export function renderAppleMusic(box){
  let v=views.get(box);if(!v){v=mount(box);views.set(box,v)}v.tick();
}
