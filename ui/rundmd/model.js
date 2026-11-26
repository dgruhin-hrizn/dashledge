import {invoke} from '../common.js';

const key='edge.rundmd.settings.v1';
export const defaults={
  interval:'random20', overlay:'auto', names:'hide', filter:'enabled', overrides:{}, speed:'1',
  format:'12ap', style:'pinball', dots:'blink', shade:'15', transition:'random', offset:0,
  color:'#ff2432', brightness:'high', contrast:'normal', startup:'once',
  text:'', frequency:'0', move:'horizontal', position:'top', scroll:'normal', textClock:'behind', textStyle:'shadow',
  key2:'', key3:'', keyStyle:'enhanced', boot:'express', statusLed:'on', buttons:'normal', ambient:'off', sleep:'', wake:'', manualSleep:null, menuStyle:'enhanced'
};
export function settings(){
  try{return {...defaults,...JSON.parse(localStorage.getItem(key)||'{}')}}catch{return {...defaults}}
}
export function saveSettings(patch){
  localStorage.setItem(key,JSON.stringify({...settings(),...patch}));
  window.dispatchEvent(new Event('rundmdsettings'));
}
export function onSettings(fn){
  const storage=e=>{if(e.key===key)fn()};
  window.addEventListener('rundmdsettings',fn);window.addEventListener('storage',storage);
  return ()=>{window.removeEventListener('rundmdsettings',fn);window.removeEventListener('storage',storage)};
}
let catalog,catalogToken;
export function getCatalog(){
  const token=settings().cardChange;
  if(catalogToken!==token){catalog=null;catalogToken=token}
  return catalog??=invoke('rundmd_catalog').catch(e=>{catalog=null;throw e});
}
export async function importCard(){
  const next=await invoke('rundmd_import');
  if(next){catalog=Promise.resolve(next);saveSettings({overrides:{},cardChange:crypto.randomUUID()})}
  return next;
}
export function reloadCatalog(){catalog=null;return getCatalog()}
export const groupOf=name=>name.replace(/_\d+$/,'');
export const labelOf=name=>name.replaceAll('_',' ').replaceAll('#','/');
export function enabled(clip,p){return p.overrides?.[clip.name]??clip.enabled}
export function eligible(clips,p){return clips.flatMap((c,i)=>p.filter==='all'||enabled(c,p)?[i]:[])}
export function intervalMs(value){
  if(value==='random20')return (1+Math.random()*19)*1000;
  if(value==='random60')return (5+Math.random()*55)*1000;
  if(value==='off')return Infinity;
  return Number(value)*1000;
}
export function timeText(d,format){
  const pad=n=>String(n).padStart(2,'0'),h=d.getHours();
  let s=(format.startsWith('12')?String(h%12||12):pad(h))+':'+pad(d.getMinutes());
  if(format.endsWith('s'))s+=':'+pad(d.getSeconds());
  if(format==='12ap')s+=h>=12?' PM':' AM';
  return s;
}
export function scheduledSleep(date,p){
  if(!p.sleep||!p.wake||p.sleep===p.wake)return false;
  const t=timeText(date,'24');
  return p.sleep<p.wake?t>=p.sleep&&t<p.wake:t>=p.sleep||t<p.wake;
}
export function sleeping(date,p){
  const scheduled=scheduledSleep(date,p);
  const override=p.manualSleep;
  return override&&(override.until==null||date.getTime()<override.until)?override.value:scheduled;
}
export function sleepOverride(date,p){
  let until=null;
  if(p.sleep&&p.wake&&p.sleep!==p.wake){
    const times=[p.sleep,p.wake].map(t=>{
      const next=new Date(date);const [h,m]=t.split(':').map(Number);next.setHours(h,m,0,0);
      if(next<=date)next.setDate(next.getDate()+1);
      return next.getTime();
    });
    until=Math.min(...times);
  }
  return {value:!sleeping(date,p),until};
}
// RunDMD-Utils' empirically measured timing buckets. The long holds are approximate.
export const delayMs=byte=>Math.max(1,(byte&63)*[2,10,100,1000][byte>>6]);
export function decodeClip(buffer){
  const bytes=new Uint8Array(buffer),n=bytes[8],start=9+n*2, frames=[];
  if(!n||bytes.length<start||(bytes.length-start)%2048)throw Error('Invalid Run-DMD clip.');
  let total=0;
  for(let i=0;i<n;i++){
    const bitmap=bytes[9+2*i];
    if(bitmap>(bytes.length-start)/2048)throw Error('Missing Run-DMD bitmap.');
    total+=delayMs(bytes[10+2*i]);frames.push({bitmap,end:total});
  }
  const frameFor=b=>frames.findIndex(f=>f.bitmap===b);
  const first=bytes[6]?frameFor(bytes[6]):0,last=bytes[7]?frameFor(bytes[7]):-1;
  return {frames,total,pixels:bytes.subarray(start),layer:bytes[0],intro:bytes[1],outro:bytes[2],small:!!bytes[3],
    x:bytes[4],y:bytes[5],first:first<0?n:first,last:last<0?n-1:last};
}
export function frameAt(clip,ms){
  let low=0,high=clip.frames.length;
  while(low<high){const mid=(low+high)>>>1;if(ms<clip.frames[mid].end)high=mid;else low=mid+1}
  return low;
}
export function unpack(packed,bitmap,out){
  if(!bitmap){out.fill(10);return}
  const start=(bitmap-1)*2048;
  for(let i=0;i<2048;i++){const pair=packed[start+i];out[2*i]=pair>>4;out[2*i+1]=pair&15}
}
