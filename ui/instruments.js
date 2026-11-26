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
  if(!reading.nextUpdate || Date.now()>=reading.nextUpdate){
    reading.update(n);
    reading.nextUpdate=Number.isFinite(n)?Date.now()+2800:0;
  }
  if(!reading.wrapper){
    reading.wrapper=el('div','instrument-hero');
    reading.wrapper.append(el('small','caption',label),reading.root);
  }
  return reading.wrapper;
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
const historyWindow=90000;
function graph(tile,history,key,max,label,value=sample=>sample[key]){
  tile.graphs??=new Map();
  let chart=tile.graphs.get(key);
  if(!chart){
    const section=el('figure','instrument-graph'),legend=el('figcaption'),box=el('div','scope '+key);
    legend.append(el('span','',label),el('span','','90 s'));
    const viewport=svg('svg',{viewBox:'0 0 360 100',preserveAspectRatio:'none',role:'img','aria-label':label+' over the last 90 seconds'});
    const group=svg('g',{}),fill=svg('path',{class:'scope-fill'}),trace=svg('path',{class:'scope-trace','vector-effect':'non-scaling-stroke'});
    group.append(fill,trace);viewport.append(group);box.append(viewport);section.append(legend,box);
    chart={section,group,fill,trace};tile.graphs.set(key,chart);
  }
  const end=history.at(-1)?.at;
  if(end==null||chart.end===end)return chart.section;
  chart.end=end;
  const lines=[],areas=[];
  let points=[],prior;
  function finish(){
    if(!points.length)return;
    const line='M'+points.map(point=>point.join(' ')).join(' L');
    lines.push(line);areas.push(line+' V100 H'+points[0][0]+' Z');points=[];
  }
  for(const sample of history){
    const n=value(sample);
    if(!Number.isFinite(n)||sample.at-prior>3000)finish();
    if(Number.isFinite(n))points.push([(360*(1+(sample.at-end)/historyWindow)).toFixed(2),(97-0.94*cap(100*n/max)).toFixed(2)]);
    prior=sample.at;
  }
  finish();
  chart.fill.setAttribute('d',areas.join(' '));chart.trace.setAttribute('d',lines.join(' '));
  chart.animation?.cancel();
  if(!matchMedia('(prefers-reduced-motion: reduce)').matches){
    // Reveal one sample behind the clock so the entering segment has two measured endpoints.
    const offset=100*(end+1200-Date.now())/historyWindow;
    chart.animation=chart.group.animate([{transform:'translateX('+offset+'%)'},{transform:'translateX('+(offset-100)+'%)'}],{duration:historyWindow,easing:'linear',fill:'forwards'});
  }
  return chart.section;
}
function peak(history,key){
  const values=history.map(s=>s[key]).filter(Number.isFinite);
  return values.length?Math.max(...values):null;
}
function cores(values,tile){
  if(!tile.coreGroup||tile.coreBars.childElementCount!==values.length){
    tile.coreGroup=el('div','core-detail');tile.coreBars=el('div','core-bank');
    for(const _ of values){const bar=el('i');bar.append(el('b'));tile.coreBars.append(bar)}
    tile.coreGroup.append(el('small','caption','Activity by core'),tile.coreBars);
  }
  values.forEach((value,i)=>{
    const bar=tile.coreBars.children[i];bar.firstChild.style.height=cap(value)+'%';bar.title='Core '+(i+1)+' · '+pct(value);
  });
  return tile.coreGroup;
}
function dial(tile,n){
  const reading=numeric(tile,'Utilization',n,'percent');
  if(!tile.dial){
    tile.dial=el('div','dial');
    const g=svg('svg',{viewBox:'0 0 220 133','aria-hidden':'true'}),arc='M 18 108 A 92 92 0 0 1 202 108';
    tile.arc=svg('path',{d:arc,class:'dial-fill',pathLength:100});
    g.append(svg('path',{d:arc,class:'dial-track'}),tile.arc);
    for(let i=0;i<=30;i++){
      const a=Math.PI*(1+i/30),r=i%5===0?79:83;
      g.append(svg('line',{x1:110+Math.cos(a)*r,y1:108+Math.sin(a)*r,x2:110+Math.cos(a)*87,y2:108+Math.sin(a)*87,class:'dial-tick'}));
    }
    tile.dial.append(g,reading);
  }
  tile.arc.style.strokeDasharray=cap(n||0)+' 101';
  return tile.dial;
}
function memoryBands(m,tile){
  const wired=m.extra?.wired,compressed=m.extra?.compressed;
  if(!tile.memoryDetail){
    tile.memoryDetail=el('div','memory-detail');
    tile.band=el('div','memory-band');
    tile.band.append(el('i','wired'),el('i','compressed'),el('i','other'));
    tile.memoryDetail.append(el('small','caption','Physical memory allocation'),tile.band,el('dl'));
  }
  const sizes=[wired,compressed,Math.max(0,m.memory-(wired||0)-(compressed||0))];
  sizes.forEach((size,i)=>{tile.band.children[i].style.width=(m.capacity>0?cap(100*(size||0)/m.capacity):0)+'%'});
  tile.memoryDetail.lastElementChild.replaceWith(rows([['Wired',ram(wired)],['Compressed',ram(compressed)],['Swap used',ram(m.swap)]]));
  return tile.memoryDetail;
}
function capacityMap(percentage,tile){
  if(!tile.capacityGrid){
    tile.capacityGrid=svg('svg',{viewBox:'0 0 311 89',preserveAspectRatio:'none',role:'img',class:'capacity-map'});
    for(let i=0;i<96;i++)tile.capacityGrid.append(svg('rect',{x:(i%16)*19.5,y:Math.floor(i/16)*15,width:15.5,height:11,rx:1.8}));
  }
  const blocks=Math.round(96*percentage/100);
  if(tile.usedBlocks!==blocks){
    Array.from(tile.capacityGrid.children).forEach((rect,i)=>rect.setAttribute('class',i<blocks?'used':'free'));
    tile.usedBlocks=blocks;
  }
  tile.capacityGrid.setAttribute('aria-label',pct(percentage)+' capacity used');
  return tile.capacityGrid;
}
function activity(n){return Number.isFinite(n)?bytes(n)+'/s':'—'}
export function renderInstrument(kind,m,tile){
  const {slot}=tile;
  const h=m.history||[],head=tile.heading??=heading(kind),e=m.extra||{};
  switch(kind){
    case 'cpu':return [head,numeric(tile,'Processor load',m.cpu,'percent'),graph(tile,h,'cpu',100,'Total activity'),cores(m.perCore||[],tile),rows([['Logical cores',m.cores??'—'],['Recent peak',pct(peak(h,'cpu'))]])];
    case 'gpu':return [head,dial(tile,m.gpu),graph(tile,h,'gpu',100,'Device activity'),rows([['Graphics device',e.gpuName||'—'],['Recent peak',pct(peak(h,'gpu'))]])];
    case 'memory':return [head,numeric(tile,'In use',m.memory,'memory'),graph(tile,h,'memory',100,'Memory in use'),memoryBands(m,tile),rows([['Available',ram(m.capacity==null?null:m.capacity-m.memory)],['Installed',ram(m.capacity)]])];
    case 'disk':{
      const disks=m.disks||[],d=slot.volume?disks.find(d=>d.mount===slot.volume):disks.find(d=>d.mount==='/System/Volumes/Data')||disks.find(d=>d.mount==='/')||disks[0];
      const used=d?d.total-d.free:null,p=d?.total?100*used/d.total:null;
      return [head,numeric(tile,'Capacity used',p,'percent'),graph(tile,h,'disk',100,'Volume utilization',sample=>sample.volumes?.[d?.mount]),capacityMap(p,tile),rows([['Used',bytes(used)],['Available',bytes(d?.free)],['Capacity',bytes(d?.total)],['Volume',d?.name||slot.volume||'—']])];
    }
    case 'network':{
      const scale=Math.max(1,peak(h,'rx')||0,peak(h,'tx')||0);
      return [head,numeric(tile,'↓  Download',m.rx,'rate'),graph(tile,h,'rx',scale,'Receive'),numeric(tile,'↑  Upload',m.tx,'rate'),graph(tile,h,'tx',scale,'Transmit')];
    }
    case 'machine':return [head,hero('Host',m.host||'—'),rows([['Processor',m.model||'—'],['Logical cores',m.cores??'—'],['Memory',ram(m.capacity)],['macOS',m.os||'—'],['Uptime',m.uptime==null?'—':Math.floor(m.uptime/3600)+'h '+Math.floor(m.uptime/60%60)+'m']])];
    case 'power':return [head,e.battery==null?hero('Thermal state',e.thermal||'—'):numeric(tile,'Battery charge',e.battery,'percent'),rows([['Thermal state',e.thermal||'—'],['Power source',e.power||'—'],['Charging',e.charging==null?'—':e.charging?'Yes':'No']])];
    case 'interfaces':return [head,...(m.interfaces||[]).map(i=>{const section=el('section','instrument-section');section.append(el('h3','',i.name),rows([['↓ Receive',activity(i.rx)],['↑ Transmit',activity(i.tx)]]));return section})];
    case 'volumes':return [head,...(m.disks||[]).map(d=>{const section=el('section','instrument-section');section.append(el('h3','',d.name),rows([['Available',bytes(d.free)],['Capacity',bytes(d.total)]]));return section})];
  }
}
