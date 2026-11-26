// Persist only pages Music has actually returned. The cursor counts source items,
// including folders, which the picker omits.
const key='edge.applemusic.playlistPages.v1';
export const freshFor=5*60*1000;
let snapshot,pending;
function valid(p){return p&&typeof p.key==='string'&&typeof p.name==='string'&&typeof p.id==='string'}
export function cachedPlaylists(){
  if(!snapshot){
    try{
      const saved=JSON.parse(localStorage.getItem(key));
      if(Number.isFinite(saved?.at)&&Number.isInteger(saved.total)&&(saved.next===null||Number.isInteger(saved.next))&&Array.isArray(saved.rows)&&saved.rows.every(valid))snapshot=saved;
    }catch{}
  }
  return snapshot;
}
export function readPlaylistPage(request,previous,limit){
  limit=Math.min(12,Math.max(1,limit));
  const offset=previous?.next??0,token=JSON.stringify([previous?.at,offset,limit]);
  if(pending?.token===token)return pending.promise;
  const promise=request('playlists',offset,limit).then(page=>{
    if(!Array.isArray(page?.rows)||!page.rows.every(valid)||!Number.isInteger(page.total)||
       !(page.next===null||(Number.isInteger(page.next)&&page.next>offset&&page.next<=page.total)))
      throw Error('Music returned an incomplete playlist page.');
    if(previous&&(page.library!==previous.library||page.total!==previous.total))
      throw Error('Your Music library changed. Refresh to load its new order.');
    const seen=new Set(previous?.rows.map(p=>p.key));
    const extra=page.rows.filter(p=>{if(seen.has(p.key))return false;seen.add(p.key);return true});
    const result={at:previous?.at??Date.now(),library:page.library,total:page.total,next:page.next,rows:[...(previous?.rows||[]),...extra]};
    // A late reply from an older browser must not roll back a newer index.
    if(!snapshot||result.at>snapshot.at||(result.at===snapshot.at&&result.rows.length>=snapshot.rows.length)){
      snapshot=result;
      try{localStorage.setItem(key,JSON.stringify(result))}catch{}
    }
    return result;
  }).finally(()=>{if(pending?.promise===promise)pending=null});
  pending={token,promise};return promise;
}
