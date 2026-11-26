import {el,button,invoke} from './common.js';
import {daydreamCount,startDaydream} from './photo-daydream.js';
import {icon} from './admin-icons.js';

const themes={montage:'Editorial montage',instant:'Instant prints',film:'Filmstrip',panorama:'Panorama gallery',daydream:'Daydream'};
const defaults={source:'library',albums:[],theme:'montage',direction:'left',speed:'slow'};
const read=request=>invoke('photos_read',{request});
function shuffled(items){
  const a=[...items];
  for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}
  return a;
}
export function editPhotos(initial,save,{title='Apple Photos'}={}){
  const draft={...defaults,...initial,albums:[...(initial?.albums||[])]};
  const dlg=el('dialog','ph-dialog'),body=el('div','ph-options'),sources=el('div'),albums=el('div','ph-albums'),access=el('div','ph-access'),err=el('p');
  dlg.setAttribute('aria-label',title);
  let catalog=null;
  function group(label,options,name,container){
    const wrap=el('div','ph-choices');wrap.setAttribute('role','group');wrap.setAttribute('aria-label',label);
    for(const [value,text] of Object.entries(options)){
      const b=button(text,()=>{draft[name]=value;draw()});
      b.setAttribute('aria-pressed',String(draft[name]===value));
      b.disabled=name==='source'&&value==='shared'&&catalog?.sharedSupported===false;
      if(name==='theme'){const demo=el('span','ph-sample '+value);for(let i=0;i<4;i++)demo.append(el('i'));b.prepend(demo)}
      wrap.append(b);
    }
    container.append(el('h3','',label),wrap);
  }
  function draw(){
    sources.replaceChildren();albums.replaceChildren();body.replaceChildren();
    group('Photo source',{library:'Library',albums:'Selected albums',shared:'iCloud Shared Library'},'source',sources);
    if(draft.source==='albums'&&catalog?.access==='allowed'){
      for(const a of catalog.albums){
        const b=button(a.name+(a.shared?' · Shared album':''),()=>{
          draft.albums=draft.albums.includes(a.id)?draft.albums.filter(id=>id!==a.id):[...draft.albums,a.id];draw();
        });
        b.setAttribute('aria-pressed',String(draft.albums.includes(a.id)));albums.append(b);
      }
      if(!catalog.albums.length)albums.append(el('p','','No albums available in Photos.'));
    }
    group('Display theme',themes,'theme',body);
    group('Direction',{right:'Left to right →',left:'← Right to left'},'direction',body);
    group('Speed',{slow:'Slow',medium:'Steady',fast:'Brisk'},'speed',body);
    apply.disabled=catalog?.access!=='allowed'||(draft.source==='albums'&&!draft.albums.some(id=>catalog.albums.some(a=>a.id===id)))||(draft.source==='shared'&&!catalog.sharedSupported);
  }
  async function load(ask=false){
    access.replaceChildren(el('p','','Reading Photos…'));
    try{catalog=await read({action:'catalog',ask});access.replaceChildren();
      if(catalog.access!=='allowed'){
        const denied=catalog.access==='denied';
        access.append(el('p','',denied?'Enable Dashledge in System Settings → Privacy & Security → Photos.':'Allow Photos access to choose what appears on this display.'),button(denied?'Check again':'Allow Photos',()=>load(!denied)));
      }
    }catch(e){access.replaceChildren(el('p','',String(e)),button('Retry',()=>load()))}
    draw();
  }
  const apply=button('Save display',()=>{try{save(draft);dlg.close()}catch(e){err.textContent=String(e)}},'primary');
  const content=el('div','ph-form'),footer=el('footer');content.append(sources,access,albums,body);footer.append(err,button('Cancel',()=>dlg.close()),apply);
  dlg.append(el('h2','',title),content,footer);dlg.onclose=()=>dlg.remove();document.body.append(dlg);dlg.showModal();draw();load();
}

export function mountPhotos(box,slot,save){
  const settings={...defaults,...slot.photoDisplay};
  box.classList.add('ph-widget');box.dataset.theme=settings.theme;
  const track=el('div','ph-track'),controls=el('div','ph-controls'),message=el('div','ph-message');
  const configure=()=>editPhotos(settings,save);
  const pause=button('',()=>{paused=!paused;syncMotion()}),edit=button('',configure);edit.append(icon('general'));edit.setAttribute('aria-label','Configure Apple Photos');
  controls.append(pause,edit);box.append(track,message,controls);
  let disposed=false,paused=window.matchMedia('(prefers-reduced-motion: reduce)').matches,visible=false,animation=null;
  let assets=[],pool=[],ready=null,loading=false,started=false,noticeTimer;
  let drift=null;
  const right=settings.direction==='right';
  function syncMotion(){
    pause.textContent=paused?'▶':'Ⅱ';pause.setAttribute('aria-label',paused?'Resume slideshow':'Pause slideshow');
    drift?.setRunning(!paused&&visible&&!document.hidden);
    if(paused||!visible||document.hidden)animation?.pause();else animation?.play();
  }
  function info(text,action,label){
    message.replaceChildren(el('p','',text));
    if(action)message.append(button(label,action));
  }
  const recent=new Map();
  async function loadPhoto(a){
    let cached=recent.get(a.id);
    if(!cached){
      const d=await read({action:'image',id:a.id});
      const img=new Image();img.alt='';img.src=d.image;await img.decode();
      cached=img;
      if(recent.size>=12)recent.delete(recent.keys().next().value);
    }
    recent.delete(a.id);recent.set(a.id,cached);
    return {a,img:cached.cloneNode()};
  }
  async function scene(){
    if(!pool.length){
      const data=await read({action:'select',source:settings.source,albums:settings.albums});assets=shuffled(data.assets);pool=[...assets];
    }
    if(!assets.length)throw Error('No photos in this selection.');
    const aspect=box.clientWidth/Math.max(box.clientHeight,1);
    const compact=aspect<1.55;
    const count=settings.theme==='daydream'?daydreamCount(aspect):compact?1:({panorama:2,montage:4,instant:Math.min(6,Math.max(2,Math.round(aspect/.8))),film:3}[settings.theme]||3);
    const picks=pool.splice(0,count);
    const photos=await Promise.all(picks.map(async a=>{
      try{return await loadPhoto(a)}catch{return null}
    }));
    const loaded=photos.filter(Boolean);if(!loaded.length)throw Error('Photos could not load these images. Check your iCloud connection.');
    if(['montage','panorama','daydream'].includes(settings.theme))loaded.sort((x,y)=>y.a.w/y.a.h-x.a.w/x.a.h);
    const panel=el('div','ph-scene');panel.dataset.count=loaded.length;
    for(const {a,img} of loaded){
      const frame=el('figure');frame.append(img);
      if(settings.theme==='daydream'){img.dataset.asset=a.id;img.dataset.ratio=a.w/Math.max(1,a.h)}
      if(settings.theme==='film')frame.style.flexGrow=Math.min(2.6,Math.max(.55,a.w/a.h));
      panel.append(frame);
    }
    return panel;
  }
  async function preload(){
    if((!animation&&!drift)||loading||ready||disposed||!visible||document.hidden)return;
    loading=true;
    try{const page=await scene();if(!disposed)ready=page}catch{/* Keep the current photographs moving while iCloud catches up. */}
    finally{loading=false}
  }
  function cycle(){
    const duration={slow:75000,medium:48000,fast:28000}[settings.speed]||75000;
    const a='translate3d(0,0,0)',b='translate3d(-100%,0,0)';
    animation=track.animate([{transform:right?b:a},{transform:right?a:b}],{duration,easing:'linear',fill:'both'});
    syncMotion();preload();
    animation.onfinish=()=>{
      if(disposed)return;
      const leaving=right?track.lastElementChild:track.firstElementChild;
      const next=ready||leaving;leaving.remove();ready=null;
      if(right)track.prepend(next);else track.append(next);
      animation.cancel();cycle();
    };
  }
  async function start(){
    if(started||disposed)return;started=true;
    info('Loading photos…');
    try{
      const first=await scene();if(disposed)return;
      track.replaceChildren(first);message.replaceChildren();
      if(settings.theme==='daydream'){
        drift=startDaydream(first,{right,speed:settings.speed},ratio=>{
          // Prefer a photo that isn't already visible in another lane.
          const showing=new Set(Array.from(first.querySelectorAll('img'),img=>img.dataset.asset));
          const cards=Array.from(ready?.children||[]);
          const fit=card=>Math.abs(Math.log(Number(card.firstChild.dataset.ratio)/ratio));
          const next=cards.filter(card=>!showing.has(card.firstChild.dataset.asset)).sort((a,b)=>fit(a)-fit(b))[0];
          next?.remove();
          if(!next||!ready.childElementCount){ready=null;preload()}
          return next;
        });
        syncMotion();preload();return;
      }
      const second=await scene().catch(()=>first.cloneNode(true));if(disposed)return;
      if(right)track.prepend(second);else track.append(second);
      cycle();
    }catch(e){if(!disposed){started=false;info(String(e),()=>start(),'Retry')}}
  }
  function reveal(){controls.classList.add('shown');clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>controls.classList.remove('shown'),3500)}
  box.addEventListener('click',reveal);
  const observer=new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;syncMotion();if(visible){if(!started)start();else preload()}});
  function visibility(){syncMotion();if(!document.hidden&&visible)preload()}
  observer.observe(box);document.addEventListener('visibilitychange',visibility);syncMotion();reveal();
  return ()=>{disposed=true;observer.disconnect();document.removeEventListener('visibilitychange',visibility);box.removeEventListener('click',reveal);clearTimeout(noticeTimer);drift?.dispose();animation?.cancel()};
}
