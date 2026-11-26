import {el} from './common.js';

// Removed rows collapse in normal flow, carrying the remaining buttons up with them.
export function setQueueRows(list,items,onPlay,consumed=0,canPlay=uri=>/^spotify:track:[A-Za-z0-9]{22}$/.test(uri)){
  const old=[...list.querySelectorAll('.sp-item:not([inert])')];
  const available=old.slice(consumed);
  const motion=list.clientHeight>0&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
  for(const child of [...list.children])if(!child.matches('.sp-item'))child.remove();
  const rows=items.map((item,index)=>{
    const key=item.uri||JSON.stringify([item.title,item.artist]);
    const match=available.findIndex(row=>row.dataset.key===key);
    const row=match<0?el('button','sp-item'):available.splice(match,1)[0];
    if(match<0){
      row.type='button';row.dataset.key=key;
      const picture=el('img');picture.alt='';picture.onerror=()=>picture.hidden=true;
      const meta=el('span','sp-qmeta');
      meta.append(el('b','sp-queue-title'),el('small'));
      row.append(el('span','sp-index'),picture,meta);
    }
    const [number,picture,meta]=row.children;
    number.textContent=String(index+1).padStart(2,'0');
    if(picture.getAttribute('src')!==(item.art||null)){
      if(item.art)picture.src=item.art;else picture.removeAttribute('src');
    }
    picture.hidden=!item.art;
    meta.firstChild.textContent=item.title||'Unavailable item';
    meta.lastChild.textContent=item.artist||'';
    row.disabled=!canPlay(item.uri);
    row.setAttribute('aria-label','Play '+(item.title||'song')+(item.artist?' by '+item.artist:''));
    row.onclick=()=>onPlay(index);
    return row;
  });
  for(const row of old){
    if(rows.includes(row))continue;
    if(!motion){row.remove();continue}
    row.inert=true;row.setAttribute('aria-hidden','true');
    const style=getComputedStyle(row);
    row.animate([
      {height:row.offsetHeight+'px',paddingBlock:style.paddingBlock,opacity:1},
      {height:'0px',paddingBlock:'0px',borderBottomWidth:'0px',opacity:0}
    ],{duration:360,easing:'ease-in-out',fill:'forwards'}).onfinish=()=>row.remove();
  }
  // Leave surviving rows attached, including the one under a finger or keyboard focus.
  let next=list.querySelector('.sp-item:not([inert])');
  for(const row of rows){
    if(row!==next)list.insertBefore(row,next);
    next=row.nextElementSibling;
    while(next?.inert)next=next.nextElementSibling;
  }
}
