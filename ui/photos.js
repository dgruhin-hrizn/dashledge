import {el,button,invoke} from './common.js';
import {daydreamCount,startDaydream} from './photo-daydream.js';
import {icon} from './admin-icons.js';
import {openTouchKeyboard} from './search-keyboard.js';
import {themes,sources,speeds,normalize,rememberNames,blocker,albumLabel,searchAlbums,ratioOf,assign,focusPosition} from './photo-settings.js';
import {createDeck,createPacer} from './photo-deck.js';
import {stageThemes,picture,takeDistinct} from './photo-stage.js';

const read=request=>invoke('photos_read',{request});
const sourceHelp={
  library:'A shuffle of your whole library.',favorites:'Only photos you’ve hearted in Photos.',
  onthisday:'Photos taken around today’s date in earlier years.',albums:'The albums you choose below, mixed together.',
  shared:'Your iCloud Shared Photo Library.',
};

// Small album covers, shared by every editor this session and loaded only when visible.
const covers=new Map();const coverQueue=[];let coverBusy=0;
function cover(id){
  if(covers.has(id))return covers.get(id);
  const p=new Promise((resolve,reject)=>{coverQueue.push({id,resolve,reject});pump()});
  covers.set(id,p);p.catch(()=>covers.delete(id));
  if(covers.size>400)covers.delete(covers.keys().next().value);
  return p;
}
function pump(){
  while(coverBusy<4&&coverQueue.length){
    const {id,resolve,reject}=coverQueue.shift();coverBusy++;
    read({action:'image',id,size:256}).then(d=>resolve(d.image),reject).finally(()=>{coverBusy--;pump()});
  }
}
function coverImage(id,cls='ph-cover'){
  const box=el('span',cls);
  if(!id){box.classList.add('none');return box}
  const io=new IntersectionObserver(entries=>{
    if(!entries.some(e=>e.isIntersecting))return;io.disconnect();
    cover(id).then(src=>{box.style.backgroundImage=`url("${src}")`;box.classList.add('ready')},()=>box.classList.add('none'));
  });
  queueMicrotask(()=>io.observe(box));return box;
}

// One editor for the live gear, Pages & layouts and Widget Studio. Changes stay in a
// draft until Save; Cancel discards them.
export function editPhotos(initial,save,{title='Apple Photos',touch=false}={}){
  const draft=normalize(initial);
  const dlg=el('dialog','ph-dialog'),err=el('p','ph-why');err.setAttribute('role','status');
  dlg.setAttribute('aria-label',title);
  let catalog=null,query='',loadError='';
  const left=el('section','ph-col ph-what'),right=el('section','ph-col ph-how');
  function segmented(label,options,value,choose,{disabled=()=>false}={}){
    const wrap=el('div','ph-seg');wrap.setAttribute('role','group');wrap.setAttribute('aria-label',label);
    for(const [v,text] of Object.entries(options)){
      const b=button(text,()=>{choose(v);draw()});b.setAttribute('aria-pressed',String(value===v));b.disabled=disabled(v);wrap.append(b);
    }
    return wrap;
  }
  function toggle(label,on,flip){
    const b=button('',()=>{flip();draw()},'ph-toggle');b.setAttribute('role','switch');b.setAttribute('aria-checked',String(on));
    b.append(el('span','ph-switch'),el('span','',label));return b;
  }
  function chosenChips(){
    const row=el('div','ph-chosen');
    const known=new Map((catalog?.albums||[]).map(a=>[a.id,a]));
    for(const id of draft.albums){
      const a=known.get(id),missing=catalog?.access==='allowed'&&!a;
      const chip=el('span','ph-chip'+(missing?' missing':''));
      chip.append(coverImage(a?.cover,'ph-chip-cover'),el('span','',a?albumLabel(a):(draft.albumNames[id]||'Album')+(missing?' · unavailable':'')));
      const x=button('×',()=>{draft.albums=draft.albums.filter(v=>v!==id);draw()});x.setAttribute('aria-label','Remove '+(a?.name||draft.albumNames[id]||'album'));
      chip.append(x);row.append(chip);
    }
    if(!draft.albums.length)row.append(el('span','ph-hint','No albums chosen yet.'));
    return row;
  }
  function searchControl(){
    const wrap=el('div','ph-search');
    if(touch){
      wrap.append(button(query||'Search albums',()=>{
        const sheet=openTouchKeyboard({title:'Find an album',brand:'Apple Photos',icon:'widget-icons/photos.svg',placeholder:'Album or folder name',onSubmit:()=>{query=sheet.input.value.trim();sheet.dialog.close();draw()}});
        sheet.input.value=query;sheet.input.select();
      },'ph-search-button'));
    }else{
      const input=el('input');input.type='search';input.placeholder='Search albums';input.value=query;input.setAttribute('aria-label','Search albums');
      input.oninput=()=>{query=input.value;drawAlbums()};wrap.append(input);
    }
    if(query&&touch)wrap.append(button('Clear',()=>{query='';draw()}));
    return wrap;
  }
  const albumGrid=el('div','ph-album-grid');
  function drawAlbums(){
    albumGrid.replaceChildren();
    if(catalog?.access!=='allowed')return;
    const found=searchAlbums(catalog.albums,query);
    for(const [kind,label] of [['smart','Smart albums'],['album','My albums'],['shared','Shared albums']]){
      const list=found.filter(a=>a.kind===kind);if(!list.length)continue;
      albumGrid.append(el('h4','',label));
      const grid=el('div','ph-album-cards');
      for(const a of list){
        const on=draft.albums.includes(a.id);
        const card=button('',()=>{draft.albums=on?draft.albums.filter(id=>id!==a.id):[...draft.albums,a.id];draw()},'ph-album');
        card.setAttribute('aria-pressed',String(on));card.disabled=!a.count&&!on;
        const meta=el('span','ph-album-meta');
        meta.append(el('strong','',a.name),el('span','',[a.folder,a.count===0?'Empty':a.count.toLocaleString()+' photos'].filter(Boolean).join(' · ')));
        card.append(coverImage(a.cover),meta,el('span','ph-check',on?'✓':''));
        card.setAttribute('aria-label',`${albumLabel(a)}, ${a.count} photos`);
        grid.append(card);
      }
      albumGrid.append(grid);
    }
    if(!found.length)albumGrid.append(el('p','ph-hint',query?`No albums match “${query}”.`:'No albums in Photos yet.'));
  }
  function accessPanel(){
    const box=el('div','ph-access');
    if(loadError){box.append(el('p','',loadError),button('Retry',()=>load()));return box}
    if(!catalog){box.append(el('p','ph-hint','Reading Photos…'));return box}
    if(catalog.access!=='allowed'){
      const denied=catalog.access==='denied';
      box.append(el('p','',denied?'Dashledge isn’t allowed to read Photos. Turn it on in System Settings → Privacy & Security → Photos.':'Allow Photos access to choose what appears on this display.'),
        button(denied?'Check again':'Allow Photos',()=>load(!denied),'primary'));
    }
    return box;
  }
  function themeCards(){
    const grid=el('div','ph-themes');grid.setAttribute('role','group');grid.setAttribute('aria-label','Presentation');
    for(const [id,t] of Object.entries(themes)){
      const b=button('',()=>{draft.theme=id;draw()},'ph-theme');b.setAttribute('aria-pressed',String(draft.theme===id));
      const demo=el('span','ph-demo '+id);for(let i=0;i<6;i++)demo.append(el('i'));
      const words=el('span','ph-theme-words');words.append(el('strong','',t.name),el('span','',t.blurb));
      b.append(demo,words);grid.append(b);
    }
    return grid;
  }
  function draw(){
    const scroll=[left.scrollTop,right.scrollTop];
    left.replaceChildren(el('h3','','Photos'),
      segmented('Photo source',sources,draft.source,v=>draft.source=v,{disabled:v=>v==='shared'&&catalog?.sharedSupported===false}),
      el('p','ph-hint',sourceHelp[draft.source]),accessPanel());
    if(draft.source==='albums'){
      left.append(el('h3','',`Chosen albums (${draft.albums.length})`),chosenChips());
      if(catalog?.access==='allowed'){left.append(searchControl(),albumGrid);drawAlbums()}
    }else left.append(toggle('Skip screenshots',draft.skipScreenshots,()=>draft.skipScreenshots=!draft.skipScreenshots));
    const t=themes[draft.theme],table=draft.theme==='table';
    right.replaceChildren(el('h3','','Presentation'),themeCards(),el('h3','','Pace'),segmented('Pace',speeds,draft.speed,v=>draft.speed=v));
    if(t.scroll||draft.theme==='daydream'||table)right.append(el('h3','',table?'Prints arrive from':'Direction'),
      segmented('Direction',table?{left:'The right',right:'The left'}:{right:'Left to right →',left:'← Right to left'},draft.direction,v=>draft.direction=v));
    right.append(toggle('Show dates',draft.captions,()=>draft.captions=!draft.captions));
    [left.scrollTop,right.scrollTop]=scroll;
    const why=blocker(draft,catalog);err.textContent=why||'';apply.disabled=!!why;
  }
  async function load(ask=false){
    loadError='';catalog=null;draw();
    try{catalog=await read({action:'catalog',ask});dressDemos()}
    catch(e){loadError=String(e?.message||e)}
    draw();
  }
  // Let the theme previews show the person's own photos once covers are in.
  function dressDemos(){
    const ids=[...new Set(catalog?.albums?.filter(a=>a.cover&&a.count).map(a=>a.cover))].slice(0,6);
    ids.forEach((id,i)=>cover(id).then(src=>dlg.style.setProperty('--demo'+(i+1),`url("${src}")`),()=>{}));
  }
  const apply=button('Save display',()=>{
    try{save(rememberNames(draft,catalog));dlg.close()}catch(e){err.textContent=String(e?.message||e)}
  },'primary');
  const head=el('header'),words=el('div'),logo=el('img'),footer=el('footer'),cols=el('div','ph-cols');
  logo.src='widget-icons/photos.svg';logo.alt='';
  words.append(el('h2','',title),el('span','ph-scope','Changes apply to this placement only.'));head.append(logo,words);
  cols.append(left,right);footer.append(err,button('Cancel',()=>dlg.close()),apply);
  dlg.append(head,cols,footer);dlg.onclose=()=>dlg.remove();document.body.append(dlg);
  if(touch)dlg.classList.add('touch');
  dlg.showModal();draw();load();
}

// ---------- The live widget ----------
const scrollCounts={panorama:2,montage:4,film:3};
export function mountPhotos(box,slot,save){
  const settings=normalize(slot.photoDisplay);
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Moving galleries become a calm crossfade when motion is reduced.
  const theme=reduced&&(themes[settings.theme].scroll||settings.theme==='daydream')?'cinema':settings.theme;
  box.classList.add('ph-widget');box.dataset.theme=theme;
  const stage=el('div','ph-stage'),controls=el('div','ph-controls'),message=el('div','ph-message');
  const deck=createDeck(settings,slot.id||'photos');
  const configure=()=>editPhotos(settings,save,{touch:true,title:'Apple Photos · This placement'});
  // Each run draws into its own layer with its own clock, so a restart (after a resize
  // or a retry) can't be written into by the run it replaced.
  let paused=false,visible=false,disposed=false,noticeTimer,run=null,size='';
  const pause=button('',()=>{paused=!paused;sync();reveal()});
  // Next also resumes, so the change it asks for is seen.
  const skip=button('',()=>{if(paused){paused=false;sync()}run?.runner?.next?.();reveal()});skip.setAttribute('aria-label','Next photo');skip.append(glyph('next'));
  const edit=button('',configure);edit.append(icon('general'));edit.setAttribute('aria-label','Configure Apple Photos');
  controls.append(pause,...(stageThemes[theme]?[skip]:[]),edit);box.append(stage,message,controls);
  const running=()=>!paused&&visible&&!document.hidden;
  function sync(){
    pause.replaceChildren(glyph(paused?'play':'pause'));pause.setAttribute('aria-label',paused?'Resume slideshow':'Pause slideshow');
    pause.setAttribute('aria-pressed',String(paused));
    run?.pacer.set(running());run?.runner?.setRunning?.(running());
    if(running()&&!run&&!message.dataset.failed)start();
  }
  function info(text,action,label){
    message.replaceChildren(el('p','',text));
    if(action)message.append(button(label,action,'primary'));
  }
  function stop(){
    if(!run)return;
    run.runner?.stop?.();run.pacer.dispose();run.observer.disconnect();run.layer.remove();run=null;
  }
  function fail(current,e){
    if(disposed||run!==current)return;
    stop();message.dataset.failed='1';
    const text=String(e?.message||e),retry=()=>{delete message.dataset.failed;message.replaceChildren();sync()};
    if(/Allow Photos/.test(text))info(text,configure,'Open settings');
    else if(/^No |no photos/.test(text))info(text,configure,'Choose photos');
    else info(text,retry,'Retry');
  }
  function start(){
    if(run||disposed)return;
    const layer=el('div','ph-run'),pacer=createPacer();stage.append(layer);
    const current={layer,pacer,runner:null};run=current;
    if(!stage.querySelector('.ph-run img'))info('Loading photos…');
    // Clear the loading note once the run shows its first photograph.
    const observer=new MutationObserver(()=>{if(layer.querySelector('img')){if(run===current&&!message.dataset.failed)message.replaceChildren();observer.disconnect()}});
    observer.observe(layer,{childList:true,subtree:true});current.observer=observer;
    const ctx={deck,pacer,settings,reduced,fail:e=>fail(current,e)};
    current.runner=stageThemes[theme]?stageThemes[theme](layer,ctx):theme==='daydream'?daydream(layer,ctx):scroller(layer,ctx,theme);
    pacer.set(running());current.runner?.setRunning?.(running());
  }
  // Layouts are measured when built; rebuild them when the placement changes size.
  let resizeTimer;
  const resized=new ResizeObserver(([entry])=>{
    const next=Math.round(entry.contentRect.width/8)+'x'+Math.round(entry.contentRect.height/8);
    if(next===size)return;const first=!size;size=next;if(first)return;
    clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(run&&!disposed){stop();sync()}},450);
  });
  resized.observe(box);
  function reveal(){controls.classList.add('shown');clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>controls.classList.remove('shown'),3500)}
  box.addEventListener('click',reveal);
  const observer=new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;sync()});
  observer.observe(box);document.addEventListener('visibilitychange',sync);sync();reveal();
  return ()=>{disposed=true;observer.disconnect();resized.disconnect();clearTimeout(resizeTimer);document.removeEventListener('visibilitychange',sync);box.removeEventListener('click',reveal);
    clearTimeout(noticeTimer);stop();deck.dispose()};
}
function glyph(kind){
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
  const path=document.createElementNS(ns,'path');path.setAttribute('fill','currentColor');
  path.setAttribute('d',{pause:'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',play:'M8 5.5v13l10.5-6.5z',next:'M5.5 5.5v13L14 12zM15 5.5h3v13h-3z'}[kind]);
  svg.append(path);return svg;
}

// ---------- Gliding galleries (montage, instant prints, filmstrip, panorama) ----------
function scroller(stage,ctx,theme){
  const {deck,pacer,settings}=ctx,right=settings.direction==='right';
  const track=el('div','ph-track');
  let ready=null,loading=false,stopped=false,animation=null;
  async function scene(){
    const W=stage.clientWidth,H=Math.max(1,stage.clientHeight),aspect=W/H,compact=aspect<1.55;
    const count=compact?1:theme==='instant'?Math.min(6,Math.max(2,Math.round(aspect/.8))):scrollCounts[theme]||3;
    // Each opening's shape, so photos go where they fit.
    let slots=new Array(count).fill(aspect/count);
    if(compact)slots=[aspect];
    else if(theme==='montage')slots=[1.65/3.5*aspect,aspect/3.5*2,aspect/3.5*2,.85/3.5*aspect];
    else if(theme==='panorama')slots=[2.5/3.5*aspect,aspect/3.5];
    else if(theme==='instant')slots=new Array(count).fill(1.03);
    const assets=await takeDistinct(deck,slots.length);
    const fitted=theme==='film'?assets:assign(assets,slots.slice(0,assets.length));
    const frames=await Promise.all(fitted.map(async(a,i)=>{
      if(!a)return null;
      const slot=slots[i];
      try{
        const entry={asset:a,...await deck.image(a,slot*H,H,{focus:theme!=='panorama'})};
        if(theme==='instant'||theme==='film'){
          const f=el('figure'),img=new Image();img.src=entry.src;img.alt='';img.style.objectPosition=focusPosition(entry.focus);f.append(img);
          if(theme==='film')f.style.flexGrow=Math.min(2.6,Math.max(.55,ratioOf(a)));
          return f;
        }
        return picture(entry,slot,theme==='panorama'||compact?{fit:'contain'}:{});
      }catch{return null}
    }));
    const loaded=frames.filter(Boolean);if(!loaded.length)throw Error('Photos could not load these images. Check your iCloud connection.');
    const panel=el('div','ph-scene');panel.dataset.count=loaded.length;panel.append(...loaded);return panel;
  }
  async function preload(){
    if(loading||ready||stopped)return;loading=true;
    try{const p=await scene();if(!stopped)ready=p}catch{/* keep the current photographs moving while iCloud catches up */}
    finally{loading=false}
  }
  function cycle(){
    const duration={slow:75000,medium:48000,fast:28000}[settings.speed]||75000;
    const a='translate3d(0,0,0)',b='translate3d(-100%,0,0)';
    animation=pacer.animate(track,[{transform:right?b:a},{transform:right?a:b}],{duration,easing:'linear',fill:'both'});
    preload();
    animation.onfinish=()=>{
      if(stopped)return;
      const leaving=right?track.lastElementChild:track.firstElementChild;
      const next=ready||leaving;leaving.remove();ready=null;
      if(right)track.prepend(next);else track.append(next);
      animation.cancel();cycle();
    };
  }
  (async()=>{
    try{
      const first=await scene();if(stopped)return;track.append(first);stage.append(track);
      const second=await scene().catch(()=>first.cloneNode(true));if(stopped)return;
      if(right)track.prepend(second);else track.append(second);
      cycle();
    }catch(e){if(!stopped)ctx.fail(e)}
  })();
  return {stop(){stopped=true;animation?.cancel()}};
}

// ---------- Daydream ----------
function daydream(stage,ctx){
  const {deck,settings}=ctx,right=settings.direction==='right';
  let drift=null,stopped=false,queue=[],filling=false,running=false;
  async function card(ratio){
    const W=stage.clientWidth,H=stage.clientHeight;
    const e=await deck.next(ratio,W*.3,H*.9,{focus:true});
    const f=el('figure'),img=new Image();img.src=e.src;img.alt='';img.dataset.asset=e.asset.id;img.dataset.ratio=ratioOf(e.asset);
    img.style.objectPosition=focusPosition(e.focus);f.append(img);return f;
  }
  async function fill(){
    if(filling||stopped||!running||queue.length>=3)return;filling=true;
    try{while(queue.length<3&&!stopped)queue.push(await card())}catch{/* retry on the next change */}finally{filling=false}
  }
  (async()=>{
    try{
      const W=stage.clientWidth,H=Math.max(1,stage.clientHeight);
      const n=daydreamCount(W/H),cards=[];
      for(let i=0;i<n;i++){try{cards.push(await card())}catch(e){if(!cards.length)throw e;break}}
      if(stopped)return;
      cards.sort((x,y)=>Number(y.firstChild.dataset.ratio)-Number(x.firstChild.dataset.ratio));
      const panel=el('div','ph-scene');panel.append(...cards);stage.append(panel);
      drift=startDaydream(panel,{right,speed:settings.speed},ratio=>{
        // Prefer a photo shaped like the opening that isn't already showing.
        const showing=new Set(Array.from(panel.querySelectorAll('img'),img=>img.dataset.asset));
        const fit=c=>Math.abs(Math.log(Number(c.firstChild.dataset.ratio)/ratio));
        const next=queue.filter(c=>!showing.has(c.firstChild.dataset.asset)).sort((a,b)=>fit(a)-fit(b))[0];
        if(next)queue=queue.filter(c=>c!==next);
        fill();return next;
      });
      drift.setRunning(running);fill();
    }catch(e){if(!stopped)ctx.fail(e)}
  })();
  return {setRunning(v){running=v;drift?.setRunning(v);if(v)fill()},stop(){stopped=true;drift?.dispose()}};
}
