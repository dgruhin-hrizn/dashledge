// Apple Photos placement settings and the aspect-ratio rules every theme shares.
// Nothing here touches the DOM, so tests can import it directly.

export const themes={
  cinema:{name:'Cinema',blurb:'One photo at a time, slow push-in, soft ambient fill',stage:true},
  mosaic:{name:'Living mosaic',blurb:'A wall of photos that flip one by one',stage:true},
  table:{name:'Light table',blurb:'Prints tossed onto a table, piling up',stage:true},
  gallery:{name:'Gallery wall',blurb:'Matted frames under spotlights',stage:true},
  daydream:{name:'Daydream',blurb:'A drifting collage that gently changes',stage:true},
  montage:{name:'Editorial montage',blurb:'Magazine spreads gliding past',scroll:true},
  instant:{name:'Instant prints',blurb:'A row of instant prints gliding past',scroll:true},
  film:{name:'Filmstrip',blurb:'Sprocketed frames rolling by',scroll:true},
  panorama:{name:'Panorama gallery',blurb:'Whole photos, never cropped',scroll:true},
};
export const sources={
  library:'Library',favorites:'Favorites',onthisday:'On this day',albums:'Albums',shared:'Shared Library',
};
export const speeds={slow:'Slow',medium:'Steady',fast:'Brisk'};
export const defaults={source:'library',albums:[],albumNames:{},theme:'cinema',direction:'left',speed:'slow',captions:true,skipScreenshots:true};

// Read whatever a placement saved, from any version, without losing a choice.
// A saved theme is never swapped for the new default; only an unknown one falls back.
export function normalize(raw){
  const s={...defaults,...(raw&&typeof raw==='object'?raw:{})};
  if(!themes[s.theme])s.theme=raw?.theme?'montage':defaults.theme;
  if(!sources[s.source])s.source='library';
  if(!speeds[s.speed])s.speed='slow';
  if(!['left','right'].includes(s.direction))s.direction='left';
  const names={...(raw?.albumNames||{})};
  s.albums=[...new Set((Array.isArray(s.albums)?s.albums:[]).map(a=>{
    if(a&&typeof a==='object'){if(a.name&&!names[a.id])names[a.id]=a.name;return a.id}
    return a;
  }).filter(id=>typeof id==='string'&&id))];
  s.albumNames=Object.fromEntries(s.albums.filter(id=>names[id]).map(id=>[id,String(names[id])]));
  s.captions=s.captions!==false;s.skipScreenshots=s.skipScreenshots!==false;
  return s;
}
// Remember album names with the ids so the choice reads the same without Photos access.
export function rememberNames(settings,catalog){
  const names={...settings.albumNames};
  for(const a of catalog?.albums||[])if(settings.albums.includes(a.id))names[a.id]=a.name;
  return {...settings,albumNames:Object.fromEntries(settings.albums.filter(id=>names[id]).map(id=>[id,names[id]]))};
}
// Why Save is unavailable, said at the control. Null when the draft can be saved.
export function blocker(draft,catalog){
  if(!catalog)return 'Reading Photos…';
  if(catalog.access!=='allowed')return 'Allow Photos access to save this display.';
  if(draft.source==='shared'&&!catalog.sharedSupported)return 'This Mac’s Photos doesn’t offer the Shared Library.';
  if(draft.source==='albums'){
    if(!draft.albums.length)return 'Choose at least one album.';
    const known=new Map(catalog.albums.map(a=>[a.id,a]));
    const live=draft.albums.filter(id=>known.has(id));
    if(!live.length)return 'None of the chosen albums are in Photos any more. Remove them or pick another.';
    if(!live.some(id=>known.get(id).count!==0))return 'The chosen albums have no photos yet.';
  }
  return null;
}
export function albumLabel(album){return album.folder?album.folder+' › '+album.name:album.name}
export function searchAlbums(albums,query){
  const q=query.trim().toLocaleLowerCase();
  return q?albums.filter(a=>albumLabel(a).toLocaleLowerCase().includes(q)):albums;
}

// ---------- Aspect ratios ----------
export const ratioOf=a=>(a?.w||1)/Math.max(1,a?.h||1);
export function shape(ratio){
  if(ratio>=2.1)return 'panorama';
  if(ratio>=1.2)return 'landscape';
  if(ratio>.83)return 'square';
  return 'portrait';
}
// Fraction of the photo a cover-fit into `slot` would cut away.
export const cropLoss=(photo,slot)=>1-Math.min(photo/slot,slot/photo);
// Cover when little is lost; otherwise show the whole photo over a soft fill of itself.
export const fitMode=(photo,slot,limit=.34)=>cropLoss(photo,slot)<=limit?'cover':'contain';
// Pick the photo closest in shape to an opening, from the next few so order stays random.
export function bestFit(pool,slotRatio,look=10){
  let best=-1,score=Infinity;
  for(let i=0;i<Math.min(look,pool.length);i++){
    const d=Math.abs(Math.log(ratioOf(pool[i])/slotRatio));
    if(d<score){score=d;best=i}
  }
  return best;
}
// Match photos to openings: the most extreme openings choose first.
export function assign(photos,slots){
  const left=[...photos],out=new Array(slots.length).fill(null);
  const order=slots.map((_,i)=>i).sort((a,b)=>Math.abs(Math.log(slots[b]))-Math.abs(Math.log(slots[a])));
  for(const i of order){const k=bestFit(left,slots[i],left.length);if(k>=0)out[i]=left.splice(k,1)[0]}
  return out;
}
// CSS object-position that keeps the salient subject inside a crop.
export function focusPosition(focus){
  if(!focus)return '50% 42%';
  const c=v=>Math.round(Math.max(0,Math.min(1,v))*100);
  return c(focus.x)+'% '+c(focus.y)+'%';
}
// Smallest image the bridge should send for an opening, in device pixels.
export function sizeFor(cssW,cssH,ratio,dpr=1){
  const need=Math.max(cssW,cssH*ratio,cssH,cssW/ratio)*dpr;
  return [512,1024,1600,2048,2560,3072].find(b=>b>=need*.9)||3072;
}
// Rows of photos at their own shapes, filling the width: each row's height follows
// from the photos in it. Returns rects in the box's units and how many photos it used.
export function justify(ratios,width,height,{rows=2,gap=0}={}){
  const target=(height-gap*(rows-1))/rows,lines=[];let i=0;
  for(let r=0;r<rows&&i<ratios.length;r++){
    const line=[];let sum=0;
    while(i<ratios.length&&(!line.length||sum*target+gap*(line.length-1)<width*.92)){line.push(i);sum+=ratios[i];i++}
    lines.push({line,sum});
  }
  const rects=[];let y=0;
  const natural=lines.map(({line,sum})=>(width-gap*(line.length-1))/sum);
  const scale=(height-gap*(lines.length-1))/natural.reduce((a,b)=>a+b,0);
  lines.forEach(({line},r)=>{
    const h=natural[r]*scale;let x=0;
    for(const k of line){const w=ratios[k]*natural[r];rects.push({index:k,x,y,w,h});x+=w+gap}
    y+=h+gap;
  });
  return {rects,used:i};
}

// ---------- Captions and repeats ----------
export function dateCaption(seconds,{now=Date.now(),relative=false,locale}={}){
  if(!seconds)return '';
  const d=new Date(seconds*1000);
  const text=d.toLocaleDateString(locale,{month:'long',day:'numeric',year:'numeric'});
  if(!relative)return text;
  const years=new Date(now).getFullYear()-d.getFullYear();
  return years>0?text+' · '+(years===1?'1 year ago':years+' years ago'):text;
}
// Put photos this placement hasn't shown recently first, so restarts don't replay the same ones.
export function freshFirst(assets,seen){
  const recent=new Set(seen);
  return [...assets.filter(a=>!recent.has(a.id)),...assets.filter(a=>recent.has(a.id))];
}
export function remember(seen,id,limit=240){
  const next=seen.filter(x=>x!==id);next.push(id);
  return next.length>limit?next.slice(next.length-limit):next;
}
