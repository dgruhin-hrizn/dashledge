import {invoke} from './common.js';

export const GENERAL_KEY='edge.general.v1';
const defaults={primary:'#edf0e6',accent:'#f88d4f',vertical:false,showSeconds:false,focusMinutes:25,directTouch:true,display:'',autoUpdates:true};
export function general(){
  try{return {...defaults,...JSON.parse(localStorage.getItem(GENERAL_KEY))}}catch{return {...defaults}}
}
function cache(settings){
  const encoded=JSON.stringify(settings);
  if(localStorage.getItem(GENERAL_KEY)===encoded)return;
  localStorage.setItem(GENERAL_KEY,encoded);
  window.dispatchEvent(new Event('generalchange'));
}
export async function loadGeneral(){
  const before=localStorage.getItem(GENERAL_KEY);
  const settings=await invoke('general_settings');
  if(before===localStorage.getItem(GENERAL_KEY))cache(settings);
}
let pending=Promise.resolve(),revision=0;
export function updateGeneral(patch){
  const settings={...general(),...patch},version=++revision;
  cache(settings);
  const commit=async()=>{
    if(version!==revision)return;
    try{await invoke('save_general',{settings})}
    catch(e){if(version===revision)await loadGeneral();throw e}
  };
  pending=pending.catch(()=>{}).then(commit);
  return pending;
}
export function onGeneral(callback){
  const updated=e=>{if(e.type==='generalchange'||e.key===GENERAL_KEY)callback(general())};
  window.addEventListener('storage',updated);window.addEventListener('generalchange',updated);
  return ()=>{window.removeEventListener('storage',updated);window.removeEventListener('generalchange',updated)};
}
// Zurface 0.6 lays widgets out in this reference viewport before fitting the board to the screen.
export function dimensions(vertical){return vertical?[540,1920]:[1920,540]}
export function fitDashboard(screen,frame,fillWindow=false){
  function fit(){
    const vertical=general().vertical,[w,h]=dimensions(vertical);
    screen.dataset.vertical=String(vertical);
    if(!fillWindow)screen.style.aspectRatio=w+'/'+h;
    // Lay native-viewport pages out at the destination size so text is rasterized there.
    if(frame.hasAttribute('data-native-viewport')){
      frame.style.width=screen.clientWidth+'px';
      frame.style.height=screen.clientHeight+'px';
      frame.style.left='0';frame.style.top='0';frame.style.transform='none';
      return;
    }
    frame.style.left='';frame.style.top='';
    const scale=Math.min(screen.clientWidth/w,screen.clientHeight/h);
    // A standalone Spotify deck can reflow into the space around the reference canvas.
    const fill=scale>0&&(frame.hasAttribute('data-full-spotify')||frame.contentDocument?.querySelector('.sp-visualizer[open]'));
    frame.style.width=(fill?screen.clientWidth/scale:w)+'px';
    frame.style.height=(fill?screen.clientHeight/scale:h)+'px';
    frame.style.transform='translate(-50%,-50%) scale('+scale+')';
  }
  const resize=new ResizeObserver(fit);
  frame.addEventListener('dashboardfit',fit);
  resize.observe(screen);const off=onGeneral(fit);fit();
  return ()=>{frame.removeEventListener('dashboardfit',fit);resize.disconnect();off()};
}
// The native HID coordinates are screen points; widgets receive logical canvas points.
export function displayTouch(frame){
  let tracking=false;
  return (kind,x,y)=>{
    const rect=frame.getBoundingClientRect();
    if(kind==='down')tracking=x>=rect.left&&x<rect.right&&y>=rect.top&&y<rect.bottom;
    if(!tracking||!rect.width||!rect.height)return;
    if(kind==='up')tracking=false;
    const px=(x-rect.left)*frame.clientWidth/rect.width;
    const py=(y-rect.top)*frame.clientHeight/rect.height;
    frame.contentWindow?.__edgeTouch?.(kind,px,py);
  };
}
export async function checkUpdate(manual=false){
  const key='edge.release.check';
  const check=async()=>{
    let prior;
    try{prior=JSON.parse(localStorage.getItem(key))}catch{}
    if(!manual&&(!general().autoUpdates||Date.now()-(prior?.at||0)<(prior?.failed?3600000:86400000)))return prior;
    let result;
    try{result=await invoke('check_release')}catch(e){result={message:String(e),failed:true}}
    const saved={...result,at:Date.now()};localStorage.setItem(key,JSON.stringify(saved));return saved;
  };
  return navigator.locks?navigator.locks.request(key,check):check();
}
export function automaticUpdates(){
  const run=()=>checkUpdate().catch(()=>{});
  run();const timer=setInterval(run,3600000);
  window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
}
