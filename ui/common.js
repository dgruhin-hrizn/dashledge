import {initial} from './model.js';
const KEY='edge-workbench.layout.v1';
export function state(){
  try {const raw=JSON.parse(localStorage.getItem(KEY));if(raw?.version===1&&Array.isArray(raw.pages)&&raw.pages.length&&Array.isArray(raw.sources)&&Array.isArray(raw.plugins))return raw} catch {}
  const fresh=initial();save(fresh);return fresh;
}
export function save(s){localStorage.setItem(KEY,JSON.stringify(s))}
export function current(s){return s.pages.find(p=>p.id===localStorage.getItem('edge.current'))||s.pages[0]}
export function activate(page){localStorage.setItem('edge.current',page.id)}
export function ensure(){if(!localStorage.getItem(KEY))save(initial());return state()}
export const invoke=(method,args={})=>window.__TAURI__.core.invoke(method,args);
export function el(tag,cls='',text=''){const e=document.createElement(tag);e.className=cls;e.textContent=text;return e}
export function button(label,action,cls=''){const b=el('button',cls,label);b.type='button';b.onclick=action;return b}
export function select(options,value,change){const s=el('select');for(const [v,t] of options)s.add(new Option(t,v));s.value=value;s.onchange=()=>change(s.value);return s}
export function field(label,input){const l=el('label','field');l.append(el('span','',label),input);return l}
export function num(value,places=1){return Number.isFinite(value)?value.toLocaleString(undefined,{maximumFractionDigits:places}):'—'}
export function bytes(n){if(!Number.isFinite(n))return '—';const i=Math.min(4,Math.max(0,Math.floor(Math.log(Math.max(1,n))/Math.log(1000))));return num(n/1000**i)+' '+['B','KB','MB','GB','TB'][i]}
