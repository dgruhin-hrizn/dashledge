import {invoke} from './common.js';
import {fitDashboard,displayTouch,loadGeneral} from './general.js';
const screen=document.querySelector('.preview-screen');
const frame=screen.firstElementChild;
const stop=fitDashboard(screen,frame,true);
if(document.body.classList.contains('edge-output')){
  window.__edgeTouch=displayTouch(frame);
  window.addEventListener('keydown',e=>{
    if(e.altKey&&e.code==='KeyP'){
      e.preventDefault();
      const child=frame.contentWindow;
      child?.dispatchEvent(new child.CustomEvent('edgepagepicker'));
    }
  });
  loadGeneral().catch(()=>{});
}else{
  loadGeneral().catch(()=>{});
  document.querySelector('#move').onpointerdown=e=>{if(e.button===0)invoke('preview_control',{action:'move'})};
  document.querySelector('#close').onclick=()=>invoke('preview_control',{action:'close'});
}
window.addEventListener('pagehide',stop,{once:true});
