let opening;
function database(){
  if(!opening)opening=new Promise((resolve,reject)=>{
    const open=indexedDB.open('dashledge-apple-playlist-art',1);
    open.onupgradeneeded=()=>open.result.createObjectStore('covers',{keyPath:'key'}).createIndex('updated','at');
    open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);
  }).catch(()=>null);
  return opening;
}
async function read(key){
  const db=await database();if(!db)return;
  return new Promise(resolve=>{
    const op=db.transaction('covers').objectStore('covers').get(key);
    op.onsuccess=()=>resolve(op.result);op.onerror=()=>resolve();
  });
}
async function write(entry){
  const db=await database();if(!db)return;
  const store=db.transaction('covers','readwrite').objectStore('covers');
  store.put(entry);
  const count=store.count();
  count.onsuccess=()=>{
    let excess=count.result-512;if(excess<=0)return;
    const oldest=store.index('updated').openCursor();
    oldest.onsuccess=()=>{const cursor=oldest.result;if(cursor&&excess-->0){cursor.delete();cursor.continue()}};
  };
}
const memory=new Map();
// Read all visible cache entries independently, but leave room for playback
// commands on the serialized Music Apple-event bridge.
const queue=[];
let active=0;
function pump(){
  while(active<3&&queue.length){
    const task=queue.shift();
    if(!task.visible()){task.resolve(null);continue}
    active++;
    task.run().then(task.resolve,task.reject).finally(()=>{active--;pump()});
  }
}
function fetchVisible(visible,run){
  return new Promise((resolve,reject)=>{queue.push({visible,run,resolve,reject});pump()});
}
export function playlistCover(p,request,since=0,visible=()=>true){
  const hit=memory.get(p.key);
  if(hit&&hit.at>=since&&Date.now()-hit.at<300000){
    hit.views?.add(visible);return hit.promise;
  }
  if(memory.size>=64)memory.delete(memory.keys().next().value);
  const entry={at:Date.now(),views:new Set([visible])};
  const promise=(async()=>{
    const saved=await read(p.key).catch(()=>null);
    if(saved&&saved.at>=since&&Date.now()-saved.at<(saved.art?86400000:300000))return saved.art;
    try{
      const result=await fetchVisible(()=>Array.from(entry.views).some(view=>view()),()=>request('playlist-cover',p.id,p.key));
      if(!result){if(memory.get(p.key)===entry)memory.delete(p.key);return ''}
      const {art}=result;
      if(typeof art!=='string')return '';
      void write({key:p.key,at:Date.now(),art}).catch(()=>{});
      return art;
    }catch{return saved?.art||''}
  })();
  entry.promise=promise.finally(()=>{entry.views.clear();entry.views=null});
  memory.set(p.key,entry);return entry.promise;
}
