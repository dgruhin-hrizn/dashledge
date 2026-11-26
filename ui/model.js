import {slackWidgets} from './slack-catalog.js';
export const presets={One:[1],Two:[1,1],Three:[1,1,1],Four:[1,1,1,1],Five:[1,1,1,1,1],Six:[2,2,2],Featured:[1,2]};
export const titles={...Object.fromEntries(Object.entries(slackWidgets).map(([kind,w])=>[kind,'Slack '+w.name])),markets:'Market Watch',photos:'Apple Photos',shortcuts:'Mac Shortcuts',rundmd:'Run-DMD',cpu:'CPU',gpu:'GPU',memory:'Memory',disk:'Disk space',network:'Network',machine:'This Mac',power:'Power & thermal',interfaces:'Network interfaces',volumes:'Storage volumes',world:'World clocks',clock:'Local time',focus:'Focus timer',notes:'Scratchpad',googledesk:'Mail & Calendar',spotify:'Spotify',applemusic:'Apple Music',emby:'Emby',comfy:'ComfyUI',proxmox:'Proxmox',omlx:'oMLX',unraid:'Unraid',ember:'Ember Copper',empty:'Empty section'};
export const id=()=>crypto.randomUUID();
export const slot=(kind='empty')=>({id:id(),kind,source:'',volume:''});
export function makePage(name,preset,kinds=[]){return {id:id(),name,preset,slots:Array.from({length:count(preset)},(_,i)=>slot(kinds[i]))}}
export const count=p=>presets[p].reduce((x,y)=>x+y,0);
export function initial(){return {version:1,pages:[makePage('System','Five',['cpu','gpu','memory','disk','network']),makePage('Studio','Featured',['comfy','omlx','spotify']),makePage('Media','One',['emby']),makePage('Everyday','Four',['clock','focus','notes','machine'])],sources:[],plugins:[]}}
export const originalKinds = ['omlx', 'ember', 'proxmox', 'unraid', 'emby', 'comfy'];
export function addOriginalPages(config) {
  if (config.originalDashboards) return false;
  for (const kind of originalKinds) {
    if (config.pages.some(p => p.slots.length === 1 && p.slots[0].kind === kind)) continue;
    const page = makePage(titles[kind], 'One', [kind]);
    page.slots[0].source = config.sources.find(source => source.kind === kind)?.id || '';
    config.pages.push(page);
  }
  config.originalDashboards = true;
  return true;
}
export function resize(page,preset){
  if(!Object.hasOwn(presets,preset))throw Error('Unknown preset');
  const n=count(preset), occupied=page.slots.filter(s=>s.kind!=='empty');
  if(occupied.length>n)throw Error('Remove a widget before choosing fewer sections.');
  const kept=page.slots.length>n?occupied:page.slots;
  page.slots=Array.from({length:n},(_,i)=>kept[i]??slot());page.preset=preset;delete page.regions;delete page.divisions;
}
export function plugin(raw){
  if(!raw||raw.apiVersion!==1||!/^plugin\.[a-z0-9.-]{1,72}$/.test(raw.id)||typeof raw.title!=='string'||!raw.title.trim()||raw.title.length>64)throw Error('A widget needs an ID beginning with plugin., a title and API version 1.');
  if(!['mac','json'].includes(raw.feed)||typeof raw.field!=='string'||!raw.field.split('.').every(k=>/^[\w-]{1,64}$/.test(k)&&!['__proto__','constructor','prototype'].includes(k)))throw Error('Choose a data source and valid field path.');
  const view=raw.view||'number';
  if(!['number','trend','list'].includes(view))throw Error('Choose a number, trend or list.');
  const metadata={};
  for(const [key,limit] of [['description',240],['version',32]]){
    if(raw[key]!==undefined){
      if(typeof raw[key]!=='string'||raw[key].length>limit)throw Error('Invalid package '+key);
      metadata[key]=raw[key].trim();
    }
  }
  if(raw.iconData){
    if(typeof raw.iconData!=='string'||raw.iconData.length>87500||!/^data:image\/png;base64,iVBOR[0-9A-Za-z+/]+=*$/.test(raw.iconData))throw Error('Invalid package icon');
    metadata.iconData=raw.iconData;
  }
  return {...metadata,view,apiVersion:1,id:raw.id,title:raw.title.trim(),feed:raw.feed,field:raw.field,unit:String(raw.unit||'').slice(0,16),accent:/^#[0-9a-f]{6}$/i.test(raw.accent)?raw.accent:'#b8e883'};
}
export function readPath(data,path){return path.split('.').reduce((v,k)=>v!=null&&Object.hasOwn(v,k)?v[k]:undefined,data)}
export function regions(page){
  if(page.regions)return page.regions;
  const columns=presets[page.preset],units=page.preset==='Featured'?3:columns.length;
  let x=0;const boxes=[];
  columns.forEach((rows,i)=>{
    const width=(page.preset==='Featured'&&i===0?2:1)/units;
    for(let j=0;j<rows;j++)boxes.push({x,y:j/rows,w:width,h:1/rows});
    x+=width;
  });
  return boxes;
}
// Older layouts store just rectangles. Recover their full-width or full-height cuts
// once, then retain the actual split ancestry as sections are edited.
function recoverDivisions(cells){
  if(cells.length===1)return cells[0].id;
  for(const [axis,size] of [['x','w'],['y','h']]){
    const edges=[...new Set(cells.flatMap(c=>[c[axis],c[axis]+c[size]]).map(x=>Math.round(x*1e7)/1e7))].sort((a,b)=>a-b);
    const cuts=edges.filter(x=>!cells.some(c=>c[axis]+1e-6<x&&c[axis]+c[size]-1e-6>x));
    if(cuts.length<3)continue;
    return {axis,parts:cuts.slice(1).map((end,i)=>({
      weight:end-cuts[i],node:recoverDivisions(cells.filter(c=>c[axis]+c[size]/2>cuts[i]&&c[axis]+c[size]/2<end))
    }))};
  }
  throw Error('This layout has no shared edge to resize.');
}
function editDivisions(page,id,replacement){
  const root=page.divisions??recoverDivisions(regions(page).map((r,i)=>({...r,id:page.slots[i].id})));
  function edit(node){
    if(typeof node==='string')return node===id?replacement:node;
    const parts=node.parts.map(p=>({...p,node:edit(p.node)})).filter(p=>p.node);
    return parts.length===1?parts[0].node:{axis:node.axis,parts};
  }
  return edit(root);
}
function applyDivisions(page,tree){
  const boxes=new Map();
  function place(node,box){
    if(typeof node==='string'){boxes.set(node,box);return}
    const axis=node.axis,size=axis==='x'?'w':'h',sum=node.parts.reduce((total,p)=>total+p.weight,0);
    let offset=box[axis];
    for(const part of node.parts){
      const length=box[size]*part.weight/sum;
      place(part.node,{...box,[axis]:offset,[size]:length});
      offset+=length;
    }
  }
  place(tree,{x:0,y:0,w:1,h:1});
  page.divisions=tree;page.regions=page.slots.map(s=>boxes.get(s.id));
}
export function split(page,index,axis){
  const box=regions(page)[index];
  if(!box||!['row','column'].includes(axis))throw Error('Choose a section to split');
  if(axis==='column'?box.w<.09:box.h<.22)throw Error('This section is too small for another touch target');
  const existing=page.slots[index],added=slot();
  const tree=editDivisions(page,existing.id,{axis:axis==='column'?'x':'y',parts:[existing,added].map(s=>({weight:1,node:s.id}))});
  page.slots.splice(index+1,0,added);applyDivisions(page,tree);
}
export function removeSection(page,index){
  const selected=page.slots[index];
  if(!selected||selected.kind!=='empty')throw Error('Remove the widget first.');
  if(page.slots.length<2)throw Error('Keep one section on the page.');
  const tree=editDivisions(page,selected.id,null);
  page.slots.splice(index,1);applyDivisions(page,tree);
}
export function layout(grid,preset,custom,vertical=false){
  const source=custom||regions({preset});
  const boxes=vertical?source.map(({x,y,w,h})=>({x:y,y:x,w:h,h:w})):source;
  const round=v=>Math.round(v*1000000)/1000000;
  const bounds=(a,b)=>[...new Set(boxes.flatMap(r=>[round(r[a]),round(r[a]+r[b])]))].sort((a,b)=>a-b);
  const x=bounds('x','w'),y=bounds('y','h');
  const tracks=edges=>edges.slice(1).map((v,i)=>'minmax(0,'+round(v-edges[i])+'fr)').join(' ');
  grid.style.gridTemplateColumns=tracks(x);grid.style.gridTemplateRows=tracks(y);
  boxes.forEach((r,i)=>{const cell=grid.children[i];if(!cell)return;
    cell.style.gridColumn=(1+x.indexOf(round(r.x)))+' / '+(1+x.indexOf(round(r.x+r.w)));
    cell.style.gridRow=(1+y.indexOf(round(r.y)))+' / '+(1+y.indexOf(round(r.y+r.h)));
  });
}
