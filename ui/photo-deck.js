// Supplies a placement's photos: shuffled, shape-aware, sized for their opening,
// and with recently shown photos held back across restarts.
import {invoke} from './common.js';
import {bestFit,freshFirst,remember,ratioOf,sizeFor,withoutIds} from './photo-settings.js';

const read=request=>invoke('photos_read',{request});
function shuffled(items){
  const a=[...items];
  for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}
  return a;
}
const seenKey=id=>'ew.photos.seen.'+id;
function loadSeen(id){try{const v=JSON.parse(localStorage.getItem(seenKey(id)));return Array.isArray(v)?v:[]}catch{return []}}

export function createDeck(settings,placementId){
  let pool=[],total=0,refilling=null,seen=loadSeen(placementId),saveTimer;
  const cache=new Map();   // id → {size,src,focus}; bounded, newest last
  // Photos held out of this deck, such as one un-hearted on a Favorites placement. Kept
  // across refills, which can race the change reaching Photos.
  const dropped=new Set();
  async function refill(){
    refilling??=read({action:'select',source:settings.source,albums:settings.albums,skipScreenshots:settings.skipScreenshots})
      .then(data=>{const assets=withoutIds(data.assets,dropped);total=assets.length;pool=freshFirst(shuffled(assets),seen)})
      .finally(()=>{refilling=null});
    return refilling;
  }
  async function ensure(){if(!pool.length)await refill();if(!pool.length)throw Error(emptyMessage(settings.source))}
  function persist(){clearTimeout(saveTimer);saveTimer=setTimeout(()=>{try{localStorage.setItem(seenKey(placementId),JSON.stringify(seen))}catch{}},2000)}
  return {
    get total(){return total},
    // The next photo, preferring one shaped like the opening when a ratio is given.
    async take(slotRatio,{avoid}={}){
      await ensure();
      let i=slotRatio?bestFit(pool,slotRatio):0;
      if(avoid?.has(pool[i]?.id)){const j=pool.findIndex(a=>!avoid.has(a.id));if(j>=0)i=j}
      const [asset]=pool.splice(i,1);
      seen=remember(seen,asset.id);persist();
      if(pool.length<6&&!refilling)refill().catch(()=>{});
      return asset;
    },
    // Return photos a layout didn't use, so they come up next.
    putBack(assets){pool.unshift(...withoutIds(assets,dropped))},
    // Stop offering a photo (it stays wherever it is showing now), or offer it again.
    drop(id){dropped.add(id);pool=withoutIds(pool,dropped)},
    restore(id){dropped.delete(id)},
    // Decoded image data sized for a box of cssW × cssH.
    async image(asset,cssW,cssH,{focus=false}={}){
      const size=sizeFor(cssW,cssH,ratioOf(asset),Math.min(2,window.devicePixelRatio||1));
      const hit=cache.get(asset.id);
      if(hit&&hit.size>=size&&(!focus||hit.focused)){cache.delete(asset.id);cache.set(asset.id,hit);return hit}
      const d=await read({action:'image',id:asset.id,size,focus});
      const img=new Image();img.src=d.image;await img.decode();
      const entry={size,src:d.image,focus:d.focus||null,focused:focus};
      cache.set(asset.id,entry);
      while(cache.size>18)cache.delete(cache.keys().next().value);
      return entry;
    },
    // Take and load together, skipping photos iCloud can't deliver.
    async next(slotRatio,cssW,cssH,options={}){
      for(let attempt=0;attempt<4;attempt++){
        const asset=await this.take(slotRatio,options);
        try{return {asset,...await this.image(asset,cssW,cssH,options)}}catch{/* try another */}
      }
      throw Error('Photos could not load these images. Check your iCloud connection.');
    },
    dispose(){clearTimeout(saveTimer);try{localStorage.setItem(seenKey(placementId),JSON.stringify(seen))}catch{}cache.clear()},
  };
}
export function emptyMessage(source){
  return {favorites:'No Favorites yet. Heart some photos in Photos.',onthisday:'No photos from this time of year yet.',
    albums:'These albums have no photos.',shared:'The Shared Library has no photos.'}[source]||'No photos in this selection.';
}

// Time that passes only while the widget is visible and playing, so hidden pages and
// paused placements do no work. Animations made through it pause with it.
export function createPacer(){
  const waits=new Set(),animations=new Set();let running=false,disposed=false,last=performance.now();
  function tick(){
    const now=performance.now(),dt=now-last;last=now;
    if(!running||disposed)return;
    for(const w of [...waits]){w.left-=dt;if(w.left<=0){waits.delete(w);w.resolve()}}
  }
  const timer=setInterval(tick,250);
  return {
    get running(){return running},
    get disposed(){return disposed},
    wait(ms){
      if(disposed)return new Promise(()=>{});
      return new Promise(resolve=>{waits.add({left:ms,resolve})});
    },
    animate(node,frames,options){
      const a=node.animate(frames,options);animations.add(a);
      if(!running)a.pause();
      a.finished.catch(()=>{}).finally(()=>animations.delete(a));
      return a;
    },
    set(value){
      if(value===running)return;
      tick();running=value;last=performance.now();
      for(const a of animations){if(value)a.play();else a.pause()}
    },
    dispose(){disposed=true;clearInterval(timer);waits.clear();for(const a of animations)a.cancel();animations.clear()},
  };
}
