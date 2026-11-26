import {openVisualizer} from './spotify-visualizer.js';
import {invoke} from './common.js';


const bands=32,segments=14;
export function mountSpectrum(canvas,label,box,service='spotify'){
  const preference='edge.'+service+'.spectrum';
  const context=canvas.getContext('2d');
  const rail=canvas.parentElement,title=box.querySelector('.sp-title');
  function fitToTitle(){
    const bounds=rail.getBoundingClientRect();
    if(!bounds.height)return;
    // Convert the measured gap back to widget pixels on a scaled dashboard.
    const scale=rail.offsetHeight/bounds.height;
    const height=Math.max(0,Math.floor((bounds.top-title.getBoundingClientRect().bottom)*scale)-4);
    const size=height+'px';
    if(canvas.style.height!==size)canvas.style.height=size;
  }
  const heights=new Float32Array(bands),peaks=new Float32Array(bands);
  let active=false,running=false,blocked=false,quietSince=0,version=0;
  let viewer=null;
  function draw(values){
    const w=canvas.width,h=canvas.height,unit=h/segments;
    context.clearRect(0,0,w,h);
    context.fillStyle=getComputedStyle(canvas).color;
    for(let i=0;i<bands;i++){
      heights[i]=Math.max(values[i]*segments/255,heights[i]-.85);
      peaks[i]=Math.max(heights[i],peaks[i]-.25);
      const lit=Math.round(heights[i]);
      for(let j=0;j<lit;j++){
        context.fillRect(i*w/bands,h-(j+1)*unit,w/bands-1,unit-1);
      }
      if(peaks[i]>=1){
        context.fillRect(i*w/bands,h-Math.round(peaks[i])*unit,w/bands-1,1);
      }
    }
  }
  function clear(){heights.fill(0);peaks.fill(0);context.clearRect(0,0,canvas.width,canvas.height)}
  function visible(){return box.isConnected&&!document.hidden&&!box.closest('[hidden]')}
  function message(text){if(label.textContent!==text)label.textContent=text;viewer?.message(text)}
  async function sample(){
    if(running||blocked||!active||!visible())return;
    running=true;
    const token=version;
    let delay=40;
    try{
      const levels=await invoke('spotify_spectrum',{waveform:!!viewer,apple:service==='applemusic'});
      if(token!==version||!active||!visible())return;
      const audible=levels.slice(0,bands).some(value=>value>0);
      if(viewer){if(audible||viewer.decaysOnSilence)viewer.draw(levels)}else draw(levels);
      if(audible)quietSince=0;
      else quietSince||=Date.now();
      message(quietSince&&Date.now()-quietSince>3000?(service==='applemusic'?'No audio from Music on this Mac':'No local audio'):'');
    }catch(error){
      if(token!==version)return;
      clear();message(String(error));
      blocked=!String(error).startsWith('Play ');delay=3000;
    }finally{
      // Keep one sampling loop per mounted meter, including during the delay.
      if(active&&!blocked&&visible()){
        setTimeout(()=>{running=false;sample()},delay);
      }else running=false;
    }
  }
  function update(playing){
    const setting=localStorage.getItem(preference);
    const enabled=setting==='on'||(setting===null&&service==='applemusic');
    const shouldRun=(enabled||!!viewer)&&playing&&visible();
    viewer?.update(box.querySelector('.sp-title').textContent,box.querySelector('.sp-artist').textContent);
    if(active!==shouldRun){version++;blocked=false;quietSince=0;active=shouldRun;clear()}
    if(!active)message(viewer&&!playing?'Playback paused':'');
    else {if(!viewer)fitToTitle();sample()}
  }
  box.querySelector('.sp-vis-open').onclick=()=>{
    if(viewer)return;
    blocked=false;quietSince=0;version++;
    viewer=openVisualizer(box,()=>{viewer=null;blocked=false;version++;update(box.classList.contains('sp-playing'))},service);
    update(box.classList.contains('sp-playing'));
  };
  clear();return update;
}
