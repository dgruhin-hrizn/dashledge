import {button,el,invoke} from '../common.js';
import {settings,saveSettings,onSettings,getCatalog,reloadCatalog,eligible,enabled,decodeClip,frameAt,intervalMs,timeText,sleeping,sleepOverride,labelOf} from './model.js';
import {createDisplay,styles,analogStyles,prepareMessage,messageDuration} from './display.js';
import {openMenu} from './menu.js';

const pick=a=>a[Math.floor(Math.random()*a.length)];
export function mountDmd(box){
  const canvas=el('canvas'),screen=button('',menu,'dmd-screen'),hint=el('span','dmd-menu-hint','Menu');
  screen.setAttribute('aria-label','Open Run-DMD menu');screen.title='Open Run-DMD menu';
  screen.append(canvas,hint);box.classList.add('dmd-tile');box.replaceChildren(screen);
  const {render:draw,resize}=createDisplay(canvas);
  let p=settings(),card=null,choices=[],scene,started=0,timer,alive=true,visible=false,pausedAt,dialog=null;
  let loadingCard=0,generation=0,previous=-1,played=0,splash=null,nextMessage=Infinity,keyText='',boot=true,problem='';
  let ready,face,settingsFace;
  function changeFace(){settingsFace=p.style;face=p.style==='random'?pick(styles.map(x=>x[0]).filter(x=>!['random','cm-5-inspired',...analogStyles].includes(x))):p.style}
  function now(){return new Date(Date.now()+Number(p.offset||0))}
  function sceneAt(next){scene=next;started=performance.now();if(!visible)pausedAt=started}
  function clock(){changeFace();sceneAt({kind:'clock',duration:choices.length?intervalMs(p.interval):Infinity})}
  function resetMessage(){nextMessage=p.text&&Number(p.frequency)>0?performance.now()+Number(p.frequency)*1000:Infinity}
  function showMessage(key){
    const value=p[key].replaceAll('{time}',timeText(now(),p.format));
    if(!value)return;
    generation++;const message=prepareMessage(value,p);sceneAt({kind:'message',duration:messageDuration(value,p.scroll),message});resetMessage();wake();
  }
  function showKey(key){
    if(key==='text'){showMessage(key);return}
    keyText=keyText===key?'':key;
    if(!p[keyText])keyText='';
    generation++;clock();wake();
  }
  function showSplash(){sceneAt({kind:'splash',splash,duration:1400+Math.max(0,splash.length/64-32)*28})}
  function banner(name,then){
    sceneAt({kind:'banner',banner:name,duration:(128+name.length*6)/55*1000,then});
  }
  function transition(direction,then){
    if(p.transition==='none'||p.interval==='0'){then();return}
    const mode=p.transition==='random'?pick(['up-down','down-up','fade']):p.transition;
    sceneAt({kind:'transition',duration:240,direction,mode,then});
  }
  async function play(index){
    if(!card)return;
    const candidates=choices.length>1&&previous>=0?choices.filter(i=>i!==previous):choices;
    const i=index??pick(candidates);
    if(i==null){clock();wake();return}
    const serial=++generation;
    sceneAt({kind:'loading'});wake();
    try{
      const bytes=await invoke('rundmd_clip',{revision:card.revision,index:i});
      if(!alive||serial!==generation)return;
      const clip=decodeClip(bytes),name=labelOf(card.clips[i].name);previous=i;problem='';
      const begin=()=>sceneAt({kind:'clip',clip,name,i,duration:clip.total/Number(p.speed)});
      const enter=()=>p.names==='before'?banner(name,begin):begin();
      if(clip.intro)transition('out',enter);else enter();
      wake();
    }catch(e){if(alive&&serial===generation){problem=String(e);sceneAt({kind:'clock',duration:Infinity});wake()}}
  }
  function afterClip(){
    const ended=scene;played++;
    const finish=()=>{
      if(splash&&Number(p.startup)>0&&played%Number(p.startup)===0)showSplash();
      else clock();
    };
    const exit=()=>ended.clip.outro?transition('in',finish):finish();
    if(p.names==='after')banner(ended.name,exit);else exit();
  }
  function tick(){
    clearTimeout(timer);
    if(!alive||!visible)return;
    const t=performance.now(),date=now(),elapsed=Math.max(0,t-started);
    let wait=1000-date.getMilliseconds();
    const view={elapsed},prefs={...p,style:face,keyText:keyText?p[keyText]:null};
    if(sleeping(date,p)){view.asleep=true;screen.setAttribute('aria-label','Wake Run-DMD display')}
    else{
      screen.setAttribute('aria-label','Open Run-DMD menu');
      if(p.style==='cm-5-inspired'&&scene.kind!=='test'){
        draw(date,prefs,{cm5:true});timer=setTimeout(tick,100);return;
      }
      if(scene.kind==='clock'&&t>=nextMessage&&!keyText){showMessage('text');return}
      if(scene.kind==='clock'&&elapsed>=scene.duration){play();return}
      if(scene.kind==='clip'){
        const frame=frameAt(scene.clip,elapsed*Number(p.speed));
        if(frame>=scene.clip.frames.length){afterClip();wake();return}
        Object.assign(view,scene,{frame});
        wait=Math.min(wait,scene.clip.frames[frame].end/Number(p.speed)-elapsed);
      }else if(['message','splash','banner','transition'].includes(scene.kind)){
        if(elapsed>=scene.duration){(scene.then||clock)();wake();return}
        Object.assign(view,scene);wait=32;
        if(scene.kind==='transition'){
          const progress=elapsed/scene.duration,amount=scene.direction==='out'?progress:1-progress;
          if(scene.mode==='fade')view.alpha=1-amount;
          else{const dir=scene.mode.split('-')[scene.direction==='out'?0:1];view.shift=Math.round(32*amount*(dir==='up'?-1:1)*(scene.direction==='out'?1:-1))}
        }
      }else if(scene.kind==='test'){view.test=true;wait=150}
      else if(scene.kind==='clock'){
        wait=Math.min(wait,scene.duration-elapsed,nextMessage>t?nextMessage-t:Infinity);
        if(p.style==='random'&&(!choices.length||p.interval==='off')&&elapsed>=15000){clock()}
      }
    }
    draw(date,prefs,view);timer=setTimeout(tick,Math.max(8,wait));
  }
  function wake(){clearTimeout(timer);if(alive&&visible)timer=setTimeout(tick,0)}
  function visibility(){
    const on=intersects&&!document.hidden;
    if(on===visible)return;
    visible=on;
    if(on){if(pausedAt!=null){const delta=performance.now()-pausedAt;started+=delta;nextMessage+=delta;pausedAt=null}wake()}
    else{pausedAt=performance.now();clearTimeout(timer)}
  }
  function toggleSleep(){const date=now();saveSettings({manualSleep:sleepOverride(date,p)});wake()}
  function menu(){
    if(dialog?.open)return;
    if(sleeping(now(),p)){toggleSleep();return}
    if(scene.kind==='test'){clock();wake()}
    dialog=openMenu({catalog:()=>card,ready,play,message:showKey,asleep:()=>sleeping(now(),p),toggleSleep,
      test:()=>{generation++;sceneAt({kind:'test'});wake()},restart:()=>{keyText='';played=0;boot=true;load(false)},
      closed:()=>{dialog=null}});
  }
  async function load(refresh){
    const serial=++loadingCard;generation++;card=null;choices=[];splash=null;clock();resetMessage();wake();
    try{
      ready=refresh?reloadCatalog():getCatalog();
      const next=await ready;
      if(!alive||serial!==loadingCard)return;
      card=next;choices=eligible(card?.clips||[],p);
      if(card){const data=await invoke('rundmd_clip',{revision:card.revision,index:null});
        if(!alive||serial!==loadingCard)return;
        const artwork=new Uint8Array(data);
        if(artwork.length)splash=artwork}
      clock();if(boot&&splash&&p.startup!=='off')showSplash();
      if(boot&&p.boot==='verbose'){const after=scene;sceneAt({kind:'banner',banner:'RUN-DMD  '+(card?.version||'CLOCK'),duration:3400,then:()=>sceneAt(after)})}
      boot=false;
      if(!card)hint.textContent='Menu · Open card';else hint.textContent='Menu';
    }catch(e){if(alive&&loadingCard===serial){problem=String(e);hint.textContent='Menu · Card unavailable'}}
    wake();
  }
  function keys(e){
    if(!visible||dialog?.open||!(screen===document.activeElement||box.contains(document.activeElement)))return;
    const k=e.key.toLowerCase();
    if(!['a','b','c','d'].includes(k)||e.altKey||e.metaKey||e.ctrlKey)return;
    e.preventDefault();if(k==='c')menu();else if(k==='d')toggleSleep();else showKey(k==='a'?'key2':'key3');
  }
  const unsubscribe=onSettings(()=>{
    const old=p;p=settings();
    if(p.cardChange!==old.cardChange){boot=true;load(true);return}
    choices=eligible(card?.clips||[],p);resetMessage();
    if(settingsFace!==p.style)changeFace();
    if(old.interval!==p.interval||scene.kind==='clock'||(scene.kind==='clip'&&p.filter!=='all'&&!enabled(card.clips[scene.i],p))){
      generation++;clock();
    }else if(scene.kind==='loading'||scene.kind==='transition'||scene.kind==='banner'){generation++;clock()}
    wake();
  });
  const sizeObserver=new ResizeObserver(([{contentRect:{width,height}}])=>{
    if(!width||!height)return;
    // Full resolution up to the Edge's 2560 device pixels on the long side; a solo page now
    // lays the screen out at that size directly, so the dots are no longer magnified.
    const density=Math.min(window.devicePixelRatio||1,2560/Math.max(width,height));
    resize(Math.max(1,Math.round(width*density)),Math.max(1,Math.round(height*density)));
    wake();
  });
  sizeObserver.observe(screen);
  let intersects=false;
  const observer=new IntersectionObserver(entries=>{intersects=entries.at(-1).isIntersecting;visibility()});observer.observe(screen);
  document.addEventListener('visibilitychange',visibility);screen.addEventListener('keydown',keys);
  screen.addEventListener('focus',()=>{if(problem)screen.title=problem});
  load(false);
  return ()=>{alive=false;generation++;clearTimeout(timer);observer.disconnect();sizeObserver.disconnect();unsubscribe();dialog?.close();document.removeEventListener('visibilitychange',visibility);screen.removeEventListener('keydown',keys)};
}
