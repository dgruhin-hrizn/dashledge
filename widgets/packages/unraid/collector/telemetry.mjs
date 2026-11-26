import '../view/assignments.js';
export function diskSampler(){
  let previous=new Map(),latest=0;
  return disks=>{
    const devices=new Map();
    for(const d of disks){
      const group=globalThis.unraidAssignment(d);
      if(group==='Other devices'||!d.device||devices.has(d.device)||!Number.isFinite(d.read_bytes)||!Number.isFinite(d.write_bytes))continue;
      const at=Date.parse(d.timestamp);
      if(Number.isFinite(at))devices.set(d.device,{at,r:d.read_bytes,w:d.write_bytes,id:d.id??d.name,group,name:d.name});
    }
    const at=Math.max(0,...[...devices.values()].map(d=>d.at));
    if(at<=latest)return;
    const point={at,start:latest||at,read:null,write:null,poolRead:null,poolWrite:null,devices:{}};
    for(const [name,d] of devices){
      const old=previous.get(name),dt=(d.at-old?.at)/1000;
      if(!old||old.id!==d.id||old.group!==d.group||!(dt>0&&dt<=660)||d.r<old.r||d.w<old.w)continue;
      const read=(d.r-old.r)/dt,write=(d.w-old.w)/dt;
      point.devices[d.name]={read,write};
      const pool=d.group==='Pool devices';
      point[pool?'poolRead':'read']+=read;
      point[pool?'poolWrite':'write']+=write;
    }
    previous=devices;latest=at;
    return point;
  };
}
export function append(series,point,now,windowMs=300000){
  if(point && (!series.length||point.at>series.at(-1).at))series.push(point);
  while(series.length && series[0].at<now-windowMs)series.shift();
}
