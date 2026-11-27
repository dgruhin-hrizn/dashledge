// The stage themes: each composes the photos it is given to their real shapes.
// start(stage,ctx) → {next()} ; ctx = {deck,pacer,settings,reduced,fail}
import {el} from './common.js';
import {ratioOf,fitMode,focusPosition,justify,dateCaption} from './photo-settings.js';

const pick=(items)=>items[Math.floor(Math.random()*items.length)];
const rand=(a,b)=>a+Math.random()*(b-a);
function alt(asset){
  const when=dateCaption(asset?.date);
  return when?'Photo from '+when:'Photo';
}
function caption(asset,settings){
  if(!settings.captions)return '';
  return dateCaption(asset?.date,{relative:settings.source==='onthisday'});
}
// A photo for an opening of `slot` ratio. When cropping would cut away too much,
// show the whole photo over a soft, blurred fill of itself instead.
export function picture(entry,slot,{fit}={}){
  const f=el('figure','ph-pic'),mode=fit||fitMode(ratioOf(entry.asset),slot);
  f.dataset.fit=mode;
  if(mode==='contain'){const back=new Image();back.src=entry.src;back.alt='';back.className='ph-ambient';f.append(back)}
  const img=new Image();img.src=entry.src;img.alt=alt(entry.asset);img.className='ph-photo';
  img.style.objectPosition=focusPosition(entry.focus);img.dataset.id=entry.asset?.id||'';
  f.append(img);return f;
}
const size=stage=>({W:Math.max(1,stage.clientWidth),H:Math.max(1,stage.clientHeight)});
// A wait the user can cut short with Next.
function skippable(pacer,ms){
  let skip;const done=Promise.race([pacer.wait(ms),new Promise(r=>{skip=r})]);
  return {done,skip:()=>skip()};
}
function loop(ctx,body){
  let current=null,stopped=false;
  (async()=>{
    try{await body(ms=>{current=skippable(ctx.pacer,ms);return current.done})}
    catch(e){if(!ctx.pacer.disposed&&!stopped)ctx.fail(e)}
  })();
  return {next(){current?.skip()},stop(){stopped=true}};
}

// Up to n different photos; a small album gives fewer rather than repeating on one screen.
export async function takeDistinct(deck,n){
  const out=[],ids=new Set();
  for(let i=0;i<n;i++){
    let a;try{a=await deck.take()}catch(e){if(!out.length)throw e;break}
    if(ids.has(a.id)){deck.putBack([a]);break}
    ids.add(a.id);out.push(a);
  }
  return out;
}
const lastingErrors=/^No |no photos|Allow Photos/;

// ---------- Cinema ----------
// One photo fills the display with a slow push toward its subject. When a photo's
// shape is far from the display's, like portraits on the wide Edge, it shares the
// screen with photos of the same shape instead of being cropped to a sliver.
export function cinema(stage,ctx){
  const {deck,pacer,settings,reduced}=ctx;
  stage.classList.add('ph-cinema');
  const hold={slow:16000,medium:11000,fast:7000}[settings.speed]||16000;
  let zoomIn=true;
  // A photo iCloud can't deliver is skipped; an empty selection is reported.
  async function compose(){
    let last;
    for(let i=0;i<4;i++){try{return await composeOnce()}catch(e){if(lastingErrors.test(String(e?.message||e)))throw e;last=e}}
    throw last;
  }
  async function composeOnce(){
    const {W,H}=size(stage),box=W/H,gap=Math.max(6,H*.012);
    // Choose the photos first, then load each at the size it will be drawn.
    const firstAsset=await deck.take(box);
    const r=ratioOf(firstAsset),vertical=r>box;
    let n=1;
    if(fitMode(r,box)==='contain')n=Math.max(1,Math.min(3,Math.round(vertical?r/box:box/Math.max(r,.55))));
    const panelRatio=vertical?W/((H-gap*(n-1))/n):((W-gap*(n-1))/n)/H;
    const chosen=[firstAsset],avoid=new Set([firstAsset.id]);
    for(let i=1;i<n;i++){
      try{
        const a=await deck.take(panelRatio,{avoid});
        // Only pair distinct photos that suit the shared shape; save the others for their own turn.
        if(avoid.has(a.id)||fitMode(ratioOf(a),panelRatio)==='contain'){deck.putBack([a]);break}
        chosen.push(a);avoid.add(a.id);
      }catch{break}
    }
    const count=chosen.length,pw=vertical?W:(W-gap*(count-1))/count,ph=vertical?(H-gap*(count-1))/count:H;
    const entries=(await Promise.all(chosen.map(a=>deck.image(a,pw,ph,{focus:true}).then(d=>({asset:a,...d}),()=>null)))).filter(Boolean);
    if(!entries.length)throw Error('Photos could not load these images. Check your iCloud connection.');
    const layer=el('div','ph-cine-layer');layer.style.gap=gap+'px';
    layer.classList.toggle('stack',vertical);
    const ratio=entries.length===1?box:vertical?W/((H-gap*(entries.length-1))/entries.length):((W-gap*(entries.length-1))/entries.length)/H;
    for(const e of entries){
      const p=picture(e,ratio),text=caption(e.asset,settings);
      if(text)p.append(el('figcaption','ph-caption',text));
      layer.append(p);
    }
    return layer;
  }
  function move(layer){
    const span=hold+2600,dir=zoomIn;zoomIn=!zoomIn;
    for(const [i,p] of [...layer.children].entries()){
      const img=p.querySelector('.ph-photo'),[fx,fy]=(img.style.objectPosition||'50% 42%').split(' ').map(v=>parseFloat(v)/100);
      if(!reduced){
        const contain=p.dataset.fit==='contain';
        const s=contain?1.035:1.11,dx=contain?0:(.5-fx)*7,dy=contain?0:(.5-fy)*5;
        const a=`scale(1) translate(0,0)`,b=`scale(${s}) translate(${dx}%,${dy}%)`;
        pacer.animate(img,[{transform:dir?a:b},{transform:dir?b:a}],{duration:span,easing:'linear',fill:'both'});
        const amb=p.querySelector('.ph-ambient');
        if(amb)pacer.animate(amb,[{transform:'scale(1.2) translateX(-2%)'},{transform:'scale(1.3) translateX(2%)'}],{duration:span,easing:'linear',fill:'both'});
      }
      const cap=p.querySelector('.ph-caption');
      if(cap)pacer.animate(cap,[{opacity:0,transform:'translateY(8px)'},{opacity:1,transform:'none'}],{duration:1400,delay:900+i*250,easing:'ease-out',fill:'both'});
    }
  }
  return loop(ctx,async wait=>{
    let ready=compose();
    for(;;){
      const layer=await ready;
      stage.append(layer);move(layer);
      const fade=pacer.animate(layer,[{opacity:0},{opacity:1}],{duration:reduced?700:2400,easing:'ease-in-out',fill:'both'});
      await fade.finished.catch(()=>{});
      while(stage.children.length>1)stage.firstElementChild.remove();
      ready=compose();ready.catch(()=>{});
      await wait(hold);
    }
  });
}

// ---------- Living mosaic ----------
// Justified rows at each photo's own shape; tiles then flip, one at a time, to a
// photo shaped like the one it replaces, so the wall never reflows.
export function mosaic(stage,ctx){
  const {deck,pacer,settings,reduced}=ctx;
  stage.classList.add('ph-mosaic');
  const every={slow:4200,medium:2800,fast:1600}[settings.speed]||4200;
  async function build(){
    const {W,H}=size(stage),box=W/H,gap=Math.max(4,Math.min(W,H)*.01);
    const rows=box>=1.5?2:box>=.85?3:4;
    const assets=await takeDistinct(deck,rows*Math.ceil(box*2/rows+2)+4);
    const {rects,used}=justify(assets.map(ratioOf),W,H,{rows,gap});
    deck.putBack(assets.slice(used));
    const tiles=await Promise.all(rects.map(async r=>{
      const tile=el('div','ph-tile');Object.assign(tile.style,{left:r.x+'px',top:r.y+'px',width:r.w+'px',height:r.h+'px'});
      const card=el('div','ph-card');tile.append(card);
      try{const e={asset:assets[r.index],...await deck.image(assets[r.index],r.w,r.h,{focus:true})};card.append(picture(e,r.w/r.h))}catch{card.classList.add('blank')}
      tile.dataset.ratio=r.w/r.h;return tile;
    }));
    stage.replaceChildren(...tiles);
    tiles.forEach((t,i)=>pacer.animate(t,[{opacity:0,transform:'scale(.94)'},{opacity:1,transform:'none'}],{duration:reduced?400:900,delay:i*70,easing:'cubic-bezier(.2,.8,.2,1)',fill:'backwards'}));
    return tiles;
  }
  return loop(ctx,async wait=>{
    let tiles=await build(),recent=[],flips=0;
    for(;;){
      await wait(every);
      if(++flips%60===0){tiles=await build();continue}
      const choices=tiles.filter(t=>!recent.includes(t));const tile=pick(choices.length?choices:tiles);
      recent=[...recent.slice(-Math.min(4,tiles.length-2)),tile];
      const ratio=Number(tile.dataset.ratio),rect=tile.getBoundingClientRect();
      const showing=new Set([...stage.querySelectorAll('.ph-photo')].map(i=>i.dataset.id));
      let next;try{next=await deck.next(ratio,rect.width,rect.height,{focus:true,avoid:showing})}catch{continue}
      const card=tile.firstElementChild,pic=picture(next,ratio);
      if(reduced){
        pic.classList.add('ph-over');card.append(pic);
        await pacer.animate(pic,[{opacity:0},{opacity:1}],{duration:900,fill:'both'}).finished.catch(()=>{});
        pic.classList.remove('ph-over');card.replaceChildren(pic);continue;
      }
      const axis=Math.random()<.5?'Y':'X';
      await pacer.animate(card,[{transform:'none'},{transform:`perspective(1400px) rotate${axis}(90deg)`}],{duration:420,easing:'cubic-bezier(.5,0,.9,.6)',fill:'forwards'}).finished.catch(()=>{});
      card.replaceChildren(pic);
      await pacer.animate(card,[{transform:`perspective(1400px) rotate${axis}(-90deg)`},{transform:'none'}],{duration:620,easing:'cubic-bezier(.1,.5,.3,1)',fill:'forwards'}).finished.catch(()=>{});
      card.getAnimations().forEach(a=>a.cancel());
    }
  });
}

// ---------- Light table ----------
// Prints land on a table one at a time. Each print keeps its photo's shape.
export function table(stage,ctx){
  const {deck,pacer,settings,reduced}=ctx;
  stage.classList.add('ph-table');
  const every={slow:7500,medium:4800,fast:2800}[settings.speed]||7500;
  const placed=[];
  function spot(w,h){
    const {W,H}=size(stage);let best=null;
    for(let i=0;i<14;i++){
      const x=rand(w*.45,W-w*.45)-w/2,y=rand(h*.42,H-h*.42)-h/2;
      const overlap=placed.slice(-4).reduce((s,p)=>s+Math.max(0,Math.min(x+w,p.x+p.w)-Math.max(x,p.x))*Math.max(0,Math.min(y+h,p.y+p.h)-Math.max(y,p.y)),0);
      if(!best||overlap<best.overlap)best={x,y,overlap};
    }
    return best;
  }
  return loop(ctx,async wait=>{
    for(let first=true;;first=false){
      const {W,H}=size(stage);
      const tall=H*(W/H<1.2?.5:.56);
      const asset=await deck.take();const r=Math.max(.6,Math.min(2.2,ratioOf(asset)));
      let ph=tall,pw=ph*r;if(pw>W*.5){pw=W*.5;ph=pw/r}
      const pad=Math.max(6,Math.min(pw,ph)*.055),w=pw+pad*2,h=ph+pad*(settings.captions?4.2:2);
      let entry;try{entry={asset,...await deck.image(asset,pw,ph,{focus:true})}}catch{await wait(800);continue}
      const print=el('div','ph-print');Object.assign(print.style,{width:w+'px',height:h+'px',padding:pad+'px',paddingBottom:(h-ph-pad)+'px'});
      const pic=picture(entry,pw/ph,{fit:'cover'});pic.style.height=ph+'px';print.append(pic);
      const text=caption(asset,settings);if(text){const c=el('span','ph-hand',text);c.style.fontSize=Math.max(11,pad*1.25)+'px';c.style.height=(h-ph-pad)+'px';print.append(c)}
      const at=spot(w,h),turn=rand(-11,11);
      Object.assign(print.style,{left:at.x+'px',top:at.y+'px',transform:`rotate(${turn}deg)`});
      stage.append(print);placed.push({x:at.x,y:at.y,w,h,node:print});
      if(!reduced){
        const side=settings.direction==='right'?-1:1,fromX=side*rand(.55,.8)*W,fromY=rand(-.5,.5)*H;
        pacer.animate(print,[
          {transform:`translate(${fromX}px,${fromY}px) rotate(${turn+side*rand(20,40)}deg) scale(1.18)`,boxShadow:'0 60px 70px #0005'},
          {transform:`translate(0,0) rotate(${turn}deg) scale(1)`,boxShadow:'0 3px 6px #0004',offset:.82},
          {transform:`translate(0,0) rotate(${turn}deg) scale(1)`,boxShadow:'0 6px 14px #0003'},
        ],{duration:1500,easing:'cubic-bezier(.16,.84,.28,1)',fill:'backwards'});
      }else pacer.animate(print,[{opacity:0},{opacity:1}],{duration:700,fill:'backwards'});
      while(placed.length>9){
        const old=placed.shift().node;
        pacer.animate(old,[{opacity:1},{opacity:0}],{duration:1400,fill:'forwards'}).finished.then(()=>old.remove(),()=>old.remove());
      }
      await wait(first?every*.6:every);
    }
  });
}

// ---------- Gallery wall ----------
// Matted frames hung on a lit wall, each sized to its photo. One frame at a time
// goes dark and returns with a photo of the same shape; the wall is rehung now and then.
export function gallery(stage,ctx){
  const {deck,pacer,settings,reduced}=ctx;
  stage.classList.add('ph-gallery');
  const every={slow:11000,medium:7000,fast:4200}[settings.speed]||11000;
  async function hang(){
    const {W,H}=size(stage),box=W/H;
    const count=box>=3?5:box>=2.2?4:box>=1.5?3:box>=.95?2:1;
    const assets=await takeDistinct(deck,count);
    const ratios=assets.map(a=>Math.max(.62,Math.min(2,ratioOf(a))));
    const base=H*.5,mat=base*.09,frame=Math.max(3,H*.012),g=W*.035;
    const total=ratios.reduce((s,r)=>s+r*base+2*(mat+frame),0)+g*(ratios.length-1);
    const k=Math.min(1,(W*.92)/total,(H*.66)/(base+2*(mat+frame)));
    const wall=el('div','ph-wall');wall.style.gap=g*k+'px';
    const frames=await Promise.all(assets.map(async(a,i)=>{
      const pw=ratios[i]*base*k,ph=base*k;
      const f=el('div','ph-frame');Object.assign(f.style,{padding:mat*k+'px',borderWidth:frame*k+'px'});
      const hole=el('div','ph-hole');Object.assign(hole.style,{width:pw+'px',height:ph+'px'});f.append(hole);
      try{hole.append(picture({asset:a,...await deck.image(a,pw,ph,{focus:true})},ratios[i],{fit:'cover'}))}catch{}
      f.dataset.ratio=ratios[i];
      const card=el('div','ph-placard',caption(a,settings));card.hidden=!card.textContent;
      const hung=el('div','ph-hung');hung.append(el('i','ph-light'),f,card);return hung;
    }));
    wall.append(...frames);
    const old=stage.firstElementChild;stage.append(wall);
    await pacer.animate(wall,[{opacity:0},{opacity:1}],{duration:reduced?600:2200,easing:'ease-in-out',fill:'backwards'}).finished.catch(()=>{});
    old?.remove();
    return frames;
  }
  return loop(ctx,async wait=>{
    let frames=await hang(),swaps=0,last=null;
    for(;;){
      await wait(every);
      if(++swaps%(frames.length*3+1)===0){frames=await hang();continue}
      const hung=pick(frames.length>1?frames.filter(f=>f!==last):frames);last=hung;
      const f=hung.querySelector('.ph-frame'),hole=f.firstElementChild,ratio=Number(f.dataset.ratio);
      let next;try{next=await deck.next(ratio,hole.clientWidth,hole.clientHeight,{focus:true})}catch{continue}
      hung.classList.add('dark');
      await pacer.wait(reduced?200:1100);
      hole.replaceChildren(picture(next,ratio,{fit:'cover'}));
      const card=hung.querySelector('.ph-placard');card.textContent=caption(next.asset,settings);card.hidden=!card.textContent;
      hung.classList.remove('dark');
    }
  });
}
export const stageThemes={cinema,mosaic,table,gallery};
