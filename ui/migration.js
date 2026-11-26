import {id} from './model.js';
import {state,save,invoke} from './common.js';

const REPORT='edge.zurface.import.v1';
export function lastImport(){
  try{return JSON.parse(localStorage.getItem(REPORT))}catch{return null}
}
function key(source){
  const url=new URL(source.address);url.pathname=url.pathname.replace(/\/+$/,'');
  return source.kind+'|'+url.href;
}
export function mergeSources(config,rows){
  let added=0;
  const byEndpoint=new Map(config.sources.map(s=>[key(s),s]));
  for(const row of rows){
    let source=byEndpoint.get(key(row));
    if(!source){
      source={id:id(),kind:row.kind,name:row.name,address:row.address};
      config.sources.push(source);byEndpoint.set(key(row),source);added++;
    }
    if(row.gpuGuests)source.gpuGuests={...row.gpuGuests,...source.gpuGuests};
  }
  for(const page of config.pages){
    const used=new Set(page.slots.map(s=>s.source).filter(Boolean));
    for(const slot of page.slots){
      if(slot.source)continue;
      const matches=config.sources.filter(s=>s.kind===slot.kind);
      const source=matches.find(s=>!used.has(s.id))||matches[0];
      if(source){slot.source=source.id;used.add(source.id)}
    }
  }
  return added;
}
let pending;
export function importConnections(retry=false){
  if(pending)return pending;
  async function run(){
    if(!retry&&lastImport())return null;
    const result=await invoke('import_zurface_connections');
    const config=state();
    const added=mergeSources(config,result.sources);
    const report={found:result.sources.length,added,issues:result.issues,ember:result.ember};
    save(config);localStorage.setItem(REPORT,JSON.stringify(report));return report;
  }
  pending=(navigator.locks?navigator.locks.request(REPORT,run):run()).finally(()=>{pending=undefined});
  return pending;
}
