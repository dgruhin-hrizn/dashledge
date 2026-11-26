// Share in-flight previews between visible copies of the widget; bound memory to recent releases.
function recent(limit){
  const entries=new Map();
  return (key,fetch)=>{
    const entry=entries.get(key);
    if(entry&&Date.now()<entry.until)return entry.promise;
    if(entries.size>=limit)entries.delete(entries.keys().next().value);
    const next={until:Date.now()+300000};
    next.promise=Promise.resolve().then(fetch).catch(()=>({}));
    entries.set(key,next);return next.promise;
  };
}
const releases=recent(12),portraits=recent(6);

export function albumImages(request,artist,album){
  return releases(JSON.stringify([artist,album]),()=>request('catalog-art',artist,album));
}
export function artistImage(request,id){
  return portraits(id,()=>request('artist-portrait',id));
}

const albums=recent(10);
export function albumTracks(request,d){
  const artist=d.albumArtist||d.artist,key=JSON.stringify([artist,d.album,d.trackCount,d.discCount]);
  return albums(key,async()=>{
    const local=await request('library-album',d.album,artist).catch(()=>[]);
    if(Array.isArray(local)&&d.trackCount>0&&d.discCount<=1&&local.length===d.trackCount&&
       new Set(local.map(t=>t.number)).size===d.trackCount&&local.every(t=>t.number>=1&&t.number<=d.trackCount))return local;
    const {collectionId}=await albumImages(request,artist,d.album);
    const catalog=collectionId?await request('catalog-album',collectionId).catch(()=>[]):[];
    if(!catalog.length)return Array.isArray(local)?local:[];
    return catalog.map(t=>{
      const saved=Array.isArray(local)&&local.find(song=>sameSong(song,t));
      return saved?{...t,uri:saved.uri}:t;
    });
  });
}

function sameText(a,b){return !!a&&!!b&&a.localeCompare(b,undefined,{sensitivity:'base'})===0}
function sameSong(a,b){
  return sameText(a.title,b.title)&&sameText(a.artist,b.artist)&&
    (!a.number||!b.number||a.number===b.number)&&(!a.disc||!b.disc||a.disc===b.disc);
}
export function followingAlbumTracks(tracks,current){
  if(!Array.isArray(tracks)||current.shuffle||current.repeat==='track')return null;
  const ordered=tracks.filter(t=>t.number>0).sort((a,b)=>(a.disc||1)-(b.disc||1)||a.number-b.number);
  const matches=ordered.filter(t=>sameSong(t,current));
  if(matches.length!==1)return null;
  const index=ordered.indexOf(matches[0]);
  const currentDisc=current.disc||1;
  const next=ordered.slice(index+1);
  // A partially saved album can have gaps when the catalog is unavailable.
  if(current.trackCount>current.number&&current.number>0&&
     !(next[0]?.number===current.number+1&&(next[0]?.disc||1)===currentDisc))return null;
  if(!next.length&&current.discCount>currentDisc)return null;
  if(current.repeat==='context')next.push(...ordered.slice(0,index+1));
  return next.slice(0,7);
}
