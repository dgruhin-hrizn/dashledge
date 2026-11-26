export const presets={One:[1],Two:[1,1],Three:[1,1,1],Four:[1,1,1,1],Five:[1,1,1,1,1],Six:[2,2,2],Featured:[1,2]};
export const titles={cpu:'CPU',gpu:'GPU',memory:'Memory',disk:'Disk space',network:'Network',machine:'This Mac',clock:'Local time',focus:'Focus timer',notes:'Scratchpad',spotify:'Spotify',emby:'Emby',comfy:'ComfyUI',proxmox:'Proxmox',omlx:'oMLX',unraid:'Unraid',ember:'Ember',empty:'Empty section'};
export const id=()=>crypto.randomUUID();
export const slot=(kind='empty')=>({id:id(),kind,source:'',volume:''});
export function makePage(name,preset,kinds=[]){return {id:id(),name,preset,slots:Array.from({length:count(preset)},(_,i)=>slot(kinds[i]))}}
export const count=p=>presets[p].reduce((x,y)=>x+y,0);
export function initial(){return {version:1,pages:[makePage('System','Five',['cpu','gpu','memory','disk','network']),makePage('Studio','Featured',['comfy','omlx','spotify']),makePage('Media','One',['emby']),makePage('Everyday','Four',['clock','focus','notes','machine'])],sources:[],plugins:[]}}
export function resize(page,preset){
  if(!Object.hasOwn(presets,preset))throw Error('Unknown preset');
  const n=count(preset), occupied=page.slots.filter(s=>s.kind!=='empty');
  if(occupied.length>n)throw Error('Remove a widget before choosing fewer sections.');
  const kept=page.slots.length>n?occupied:page.slots;
  page.slots=Array.from({length:n},(_,i)=>kept[i]??slot());page.preset=preset;
}
export function plugin(raw){
  if(!raw||raw.apiVersion!==1||!/^plugin\.[a-z0-9.-]{1,72}$/.test(raw.id)||typeof raw.title!=='string'||!raw.title.trim()||raw.title.length>64)throw Error('A widget needs an ID beginning with plugin., a title and API version 1.');
  if(!['mac','json'].includes(raw.feed)||typeof raw.field!=='string'||!raw.field.split('.').every(k=>/^[\w-]{1,64}$/.test(k)&&!['__proto__','constructor','prototype'].includes(k)))throw Error('Choose a data source and valid field path.');
  return {apiVersion:1,id:raw.id,title:raw.title.trim(),feed:raw.feed,field:raw.field,unit:String(raw.unit||'').slice(0,16),accent:/^#[0-9a-f]{6}$/i.test(raw.accent)?raw.accent:'#b8e883'};
}
export function readPath(data,path){return path.split('.').reduce((v,k)=>v!=null&&Object.hasOwn(v,k)?v[k]:undefined,data)}
export function layout(grid,preset){
  const columns=presets[preset];grid.style.gridTemplateColumns=columns.map((_,i)=>preset==='Featured'&&i===0?'2fr':'1fr').join(' ');
  grid.style.gridTemplateRows='repeat(2,minmax(0,1fr))';let at=0;
  columns.forEach((rows,i)=>{for(let j=0;j<rows;j++){const cell=grid.children[at++];if(cell){cell.style.gridColumn=String(i+1);cell.style.gridRow=rows===1?'1 / span 2':String(j+1)}}});
}
