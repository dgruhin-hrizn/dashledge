import {createReading} from './metric-reading.js';
import {el} from './common.js';
import {icon} from './admin-icons.js';

const cap=p=>Math.max(0,Math.min(100,p));
const fixed=new Intl.NumberFormat(undefined,{minimumFractionDigits:1,maximumFractionDigits:1});
const pct=n=>Number.isFinite(n)?fixed.format(n)+'%':'—';
function bytes(n){
  if(!Number.isFinite(n))return '—';
  const units=['B','KB','MB','GB','TB'];let i=0;
  while(n>=999.95&&i<units.length-1){n/=1000;i++}
  return fixed.format(n)+' '+units[i];
}
const names={cpu:'CPU',gpu:'GPU',memory:'Memory',disk:'Disk space',network:'Network',power:'Power & thermal',machine:'This Mac',interfaces:'Network interfaces',volumes:'Storage volumes'};
export const instrumentKinds=Object.keys(names);
function svg(tag,attrs){
  const e=document.createElementNS('http://www.w3.org/2000/svg',tag);
  for(const [key,value] of Object.entries(attrs))e.setAttribute(key,value);
  return e;
}
function heading(kind){
  const head=el('div','instrument-head');head.append(icon(kind),el('h2','',names[kind]));return head;
}
function hero(label,number,unit=''){
  const wrap=el('div','instrument-hero'),line=el('div','reading');
  line.append(el('strong','',number),el('span','unit',unit));wrap.append(el('small','caption',label),line);return wrap;
}
function numeric(tile,label,n,kind){
  tile.readings??=new Map();
  let reading=tile.readings.get(label);
  if(!reading){reading=createReading(label,kind);tile.readings.set(label,reading)}
  reading.update(n);
  const wrap=el('div','instrument-hero');
  wrap.append(el('small','caption',label),reading.root);
  return wrap;
}
function ram(n){
  if(!Number.isFinite(n))return '—';
  return n>0&&n<2**30?fixed.format(n/2**20)+' MiB':fixed.format(n/2**30)+' GiB';
}
function rows(items){
  const list=el('dl','instrument-facts');
  for(const [k,v] of items){const pair=el('div');pair.append(el('dt','',k),el('dd','',v));list.append(pair)}
  return list;
}
function plot(history,key,max,label){
  const box=el('div','scope '+key);
  const graph=svg('svg',{viewBox:'0 0 360 100',preserveAspectRatio:'none',role:'img','aria-label':label});
  const end=history.at(-1)?.at||0;
  let points=[],prior;
  function line(){
    if(!points.length)return;
    const coords=points.map(p=>p.join(' ')).join(' L');
    graph.append(svg('path',{d:'M'+coords+' L'+points.at(-1)[0]+' 100 H'+points[0][0]+' Z',class:'scope-fill'}),
      svg('path',{d:'M'+coords,class:'scope-trace','vector-effect':'non-scaling-stroke'}));
    points=[];
  }
  for(const sample of history){
    const n=sample[key];
    if(n==null||sample.at-prior>3500)line();
    if(Number.isFinite(n))points.push([Math.max(0,360*(1-(end-sample.at)/90000)).toFixed(1),(97-94*cap(100*n/max)/100).toFixed(1)]);
    prior=sample.at;
  }
  line();box.append(graph);return box;
}
function graph(history,key,max,label){
  const section=el('figure','instrument-graph'),legend=el('figcaption');
  legend.append(el('span','',label),el('span','','90 s'));
  section.append(legend,plot(history,key,max,label+' over the last 90 seconds'));return section;
}
function peak(history,key){
  const values=history.map(s=>s[key]).filter(Number.isFinite);
  return values.length?Math.max(...values):null;
}
function cores(values){
  const group=el('div','core-detail');group.append(el('small','caption','Activity by core'));
  const bars=el('div','core-bank');
  values.forEach((v,i)=>{const bar=el('i'),fill=el('b');fill.style.height=cap(v)+'%';bar.title='Core '+(i+1)+' · '+pct(v);bar.append(fill);bars.append(bar)});
  group.append(bars);return group;
}
function dial(tile,n){
  const wrap=el('div','dial');
  const g=svg('svg',{viewBox:'0 0 220 133','aria-hidden':'true'});
  const arc='M 18 108 A 92 92 0 0 1 202 108';
  g.append(svg('path',{d:arc,class:'dial-track'}),svg('path',{d:arc,class:'dial-fill',pathLength:100,'stroke-dasharray':cap(n||0)+' 101'}));
  for(let i=0;i<=30;i++){
    const a=Math.PI*(1+i/30),r=i%5===0?79:83;
    g.append(svg('line',{x1:110+Math.cos(a)*r,y1:108+Math.sin(a)*r,x2:110+Math.cos(a)*87,y2:108+Math.sin(a)*87,class:'dial-tick'}));
  }
  wrap.append(g,numeric(tile,'Utilization',n,'percent'));return wrap;
}
function memoryBands(m){
  const wired=m.extra?.wired,compressed=m.extra?.compressed;
  const wrap=el('div','memory-detail'),band=el('div','memory-band');
  if(m.capacity>0&&Number.isFinite(m.memory)){
    const parts=[['wired',wired],['compressed',compressed],['other',Math.max(0,m.memory-(wired||0)-(compressed||0))]];
    for(const [key,size] of parts){const part=el('i',key);part.style.width=cap(100*(size||0)/m.capacity)+'%';band.append(part)}
  }
  wrap.append(el('small','caption','Physical memory allocation'),band,rows([['Wired',ram(wired)],['Compressed',ram(compressed)],['Swap used',ram(m.swap)]]));
  return wrap;
}
function capacityMap(percentage){
  const grid=svg('svg',{viewBox:'0 0 311 89',preserveAspectRatio:'none',role:'img','aria-label':pct(percentage)+' capacity used'});
  grid.setAttribute('class','capacity-map');
  for(let i=0;i<96;i++)grid.append(svg('rect',{x:(i%16)*19.5,y:Math.floor(i/16)*15,width:15.5,height:11,rx:1.8,class:i<Math.round(96*percentage/100)?'used':'free'}));
  return grid;
}
function activity(n){return Number.isFinite(n)?bytes(n)+'/s':'—'}
export function renderInstrument(kind,m,tile){
  const {slot}=tile;
  const h=m.history||[],head=heading(kind),e=m.extra||{};
  switch(kind){
    case 'cpu':return [head,numeric(tile,'Processor load',m.cpu,'percent'),graph(h,'cpu',100,'Total activity'),cores(m.perCore||[]),rows([['Logical cores',m.cores??'—'],['Recent peak',pct(peak(h,'cpu'))]])];
    case 'gpu':return [head,dial(tile,m.gpu),graph(h,'gpu',100,'Device activity'),rows([['Graphics device',e.gpuName||'—'],['Recent peak',pct(peak(h,'gpu'))]])];
    case 'memory':return [head,numeric(tile,'In use',m.memory,'memory'),memoryBands(m),rows([['Available',ram(m.capacity==null?null:m.capacity-m.memory)],['Installed',ram(m.capacity)]])];
    case 'disk':{
      const disks=m.disks||[],d=slot.volume?disks.find(d=>d.mount===slot.volume):disks.find(d=>d.mount==='/System/Volumes/Data')||disks.find(d=>d.mount==='/')||disks[0];
      const used=d?d.total-d.free:null,p=d?.total?100*used/d.total:null;
      return [head,numeric(tile,'Capacity used',p,'percent'),capacityMap(p),rows([['Used',bytes(used)],['Available',bytes(d?.free)],['Capacity',bytes(d?.total)],['Volume',d?.name||slot.volume||'—']])];
    }
    case 'network':{
      const scale=Math.max(1,peak(h,'rx')||0,peak(h,'tx')||0);
      return [head,numeric(tile,'↓  Download',m.rx,'rate'),graph(h,'rx',scale,'Receive'),numeric(tile,'↑  Upload',m.tx,'rate'),graph(h,'tx',scale,'Transmit')];
    }
    case 'machine':return [head,hero('Host',m.host||'—'),rows([['Processor',m.model||'—'],['Logical cores',m.cores??'—'],['Memory',ram(m.capacity)],['macOS',m.os||'—'],['Uptime',m.uptime==null?'—':Math.floor(m.uptime/3600)+'h '+Math.floor(m.uptime/60%60)+'m']])];
    case 'power':return [head,e.battery==null?hero('Thermal state',e.thermal||'—'):numeric(tile,'Battery charge',e.battery,'percent'),rows([['Thermal state',e.thermal||'—'],['Power source',e.power||'—'],['Charging',e.charging==null?'—':e.charging?'Yes':'No']])];
    case 'interfaces':return [head,...(m.interfaces||[]).map(i=>{const section=el('section','instrument-section');section.append(el('h3','',i.name),rows([['↓ Receive',activity(i.rx)],['↑ Transmit',activity(i.tx)]]));return section})];
    case 'volumes':return [head,...(m.disks||[]).map(d=>{const section=el('section','instrument-section');section.append(el('h3','',d.name),rows([['Available',bytes(d.free)],['Capacity',bytes(d.total)]]));return section})];
  }
}
