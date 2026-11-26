import {initial,addOriginalPages,makePage,migratePlanSettings} from './model.js';
const KEY='edge-workbench.layout.v1';
export function state(){
  try {const raw=JSON.parse(localStorage.getItem(KEY));if(raw?.version===1&&Array.isArray(raw.pages)&&raw.pages.length&&Array.isArray(raw.sources)&&Array.isArray(raw.plugins)){if(migratePlanSettings(raw))save(raw);return raw}} catch {}
  const fresh=initial();save(fresh);return fresh;
}
export function save(s){localStorage.setItem(KEY,JSON.stringify(s))}
export function current(s){return s.pages.find(p=>p.id===localStorage.getItem('edge.current'))||s.pages[0]}
export function activate(page){localStorage.setItem('edge.current',page.id)}
export function ensure(){const config=state();if(addOriginalPages(config))save(config);return config}
export function invoke(method,args={}){
  const bridge=window.__TAURI__||(window.parent!==window&&window.parent.__TAURI__);
  if(!bridge?.core)return Promise.reject(new Error('Open the dashboard in Dashledge'));
  return bridge.core.invoke(method,args);
}
export function el(tag,cls='',text=''){const e=document.createElement(tag);e.className=cls;e.textContent=text;return e}
export function button(label,action,cls=''){const b=el('button',cls,label);b.type='button';b.onclick=action;return b}
export function select(options,value,change){const s=el('select');for(const [v,t] of options)s.add(new Option(t,v));s.value=value;s.onchange=()=>change(s.value);return s}
export function field(label,input){const l=el('label','field');l.append(el('span','',label),input);return l}
export function num(value,places=1){return Number.isFinite(value)?value.toLocaleString(undefined,{maximumFractionDigits:places}):'—'}
export function bytes(n){if(!Number.isFinite(n))return '—';const i=Math.min(4,Math.max(0,Math.floor(Math.log(Math.max(1,n))/Math.log(1000))));return num(n/1000**i)+' '+['B','KB','MB','GB','TB'][i]}

export async function addBundledDmdPage(){
  if(state().bundledDmdPage||await invoke('rundmd_has_default').catch(()=>false)!==true)return false;
  function add(){
    const config=state();
    if(config.bundledDmdPage)return false;
    config.bundledDmdPage=true;
    if(!config.removedWidgets?.includes('rundmd')&&!config.pages.some(p=>p.slots.some(s=>s.kind==='rundmd'))){
      const page=makePage('Run-DMD','One',['rundmd']);
      config.pages.push(page);save(config);activate(page);
    }else save(config);
    return true;
  }
  return navigator.locks?navigator.locks.request('edge-rundmd-page',add):add();
}
