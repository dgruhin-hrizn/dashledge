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
// Outgoing pixels are inert. The live links and touch targets stay in place.
const fading=new WeakMap();
function crossfade(node,change){
  const prior=fading.get(node);
  prior?.incoming.cancel();
  prior?.outgoing?.remove();
  fading.delete(node);
  if(matchMedia('(prefers-reduced-motion: reduce)').matches){change();return}
  const parent=node.closest('.sp-sleeve,.sp-deck');
  const rect=node.getBoundingClientRect(),frame=parent.getBoundingClientRect();
  let outgoing;
  if(rect.width&&rect.height&&frame.width&&frame.height&&getComputedStyle(node).visibility==='visible'){
    outgoing=node.cloneNode(true);
    outgoing.inert=true;outgoing.setAttribute('aria-hidden','true');
    const sx=parent.offsetWidth/frame.width,sy=parent.offsetHeight/frame.height;
    Object.assign(outgoing.style,{position:'absolute',inset:'auto',gridArea:'auto',margin:'0',transform:'none',
      left:(rect.left-frame.left)*sx+'px',top:(rect.top-frame.top)*sy+'px',
      width:rect.width*sx+'px',height:rect.height*sy+'px',pointerEvents:'none',zIndex:'1'});
    parent.append(outgoing);
  }
  change();
  const timing={duration:420,easing:'ease-in-out'};
  const incoming=node.animate([{opacity:0},{opacity:1}],timing);
  outgoing?.animate([{opacity:1},{opacity:0}],timing);
  const transition={incoming,outgoing};
  fading.set(node,transition);
  incoming.onfinish=()=>{
    outgoing?.remove();
    if(fading.get(node)===transition)fading.delete(node);
  };
}
function updateTrackText(node,value){
  if(node.textContent!==value)crossfade(node,()=>{node.textContent=value});
}
// Sample a small copy so a CDN that restricts canvas access can still serve the jacket.
function lightFromCover(box,url,isCurrent){
  const reset=()=>{if(isCurrent())box.style.removeProperty('--sp-light')};
  if(!url){reset();return}
  const sample=new Image();
  sample.crossOrigin='anonymous';
  sample.onload=()=>{
    if(!box.isConnected||!isCurrent())return;
    try{
      const canvas=document.createElement('canvas');
      canvas.width=canvas.height=12;
      const context=canvas.getContext('2d');
      context.drawImage(sample,0,0,12,12);
      const pixels=context.getImageData(0,0,12,12).data;
      const buckets=new Map();
      for(let i=0;i<pixels.length;i+=4){
        const r=pixels[i],g=pixels[i+1],b=pixels[i+2];
        const peak=Math.max(r,g,b),chroma=peak-Math.min(r,g,b);
        if(pixels[i+3]<200||peak<48||chroma<30)continue;
        const key=(r>>6)*16+(g>>6)*4+(b>>6);
        const group=buckets.get(key)||{weight:0,r:0,g:0,b:0};
        group.weight+=chroma;group.r+=r*chroma;group.g+=g*chroma;group.b+=b*chroma;
        buckets.set(key,group);
      }
      const color=[...buckets.values()].sort((a,b)=>b.weight-a.weight)[0];
      if(color){
        const rgb=[color.r,color.g,color.b].map(sum=>Math.round(sum/color.weight));
        box.style.setProperty('--sp-light','rgb('+rgb.join(' ')+')');
      }else reset();
    }catch{reset()}
  };
  sample.onerror=reset;
  sample.src=url;
}

function mountDeck(box,service='spotify'){
  const apple=service==='applemusic',brand=apple?'Apple Music':'Spotify';
  const queueTitle=apple?'Next in playlist':'Up next',searchLabel=apple?'Find songs':'Add songs';
  box.classList.add('sp-tile');
  box.innerHTML=`<div class="sp-shell">
    <div class="sp-head"><a class="sp-brand"><img src="widget-icons/${service}.svg" alt="">${brand}</a><button class="sp-device" aria-label="Playback device"><span aria-hidden="true">◉</span> <span class="sp-device-name">Playback device</span></button><button class="sp-library-toggle">Playlists</button><button class="sp-toggle" aria-expanded="false">${icon('queue')} ${queueTitle}</button></div>
    <div class="sp-layout"><div class="sp-deck"><div class="sp-sleeve"><span class="sp-record"></span><img class="sp-cover" hidden alt=""></div>
    <div class="sp-info"><div class="sp-eyebrow"><span class="sp-meter" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span class="sp-state"></span></div><a class="sp-context" hidden></a><div class="sp-title-row"><strong class="sp-title"></strong><button class="sp-save" aria-label="Save song" title="Save song">＋</button></div><button class="sp-byline"><img hidden alt=""><span class="sp-artist"></span></button><div class="sp-details"><span class="sp-album"></span><span class="sp-edition"></span></div>
    <div class="sp-timeline"><div class="sp-track"><canvas class="sp-spectrum" width="512" height="84" aria-hidden="true"></canvas><i></i><input class="sp-seek" type="range" min="0" max="1000" step="1" data-edge-range aria-label="Seek in song"></div><div class="sp-times"><span></span><small class="sp-spectrum-status" role="status"></small><span></span></div></div>
    <div class="sp-controls"></div><div class="sp-error" role="status" hidden><span></span> <button hidden>Reconnect ${brand}</button></div></div></div>
    <section class="sp-queue"><div class="sp-qhead"><b>${queueTitle}</b><button class="sp-add">${searchLabel}</button><button aria-label="Close queue">${icon('close')}</button></div><div class="sp-list"></div></section></div></div>`;
}
export {icon,time,crossfade,updateTrackText,lightFromCover,mountDeck};
