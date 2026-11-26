import {el,button} from './common.js';

const modes=['Spectrum','Oscilloscope','Waterfall','Tunnel','Feedback','Starfield','Dot fountain','Plasma','Kaleidoscope'];
const tau=2*Math.PI;
export function openVisualizer(box,onClose,service='spotify'){
  const dialog=el('dialog','sp-visualizer');
  dialog.setAttribute('aria-label','Music visualizer');
  const canvas=el('canvas'),ctx=canvas.getContext('2d',{alpha:false});
  const header=el('header'),logo=el('img'),track=el('strong'),close=button('Close',()=>dialog.close());
  logo.src='widget-icons/'+service+'.svg';logo.alt=service==='spotify'?'Spotify':'Apple Music';
  const status=el('p','sp-vis-status');status.setAttribute('role','status');
  const nav=el('nav');nav.setAttribute('aria-label','Visualization modes');
  header.append(logo,track,close);dialog.append(canvas,header,status,nav);box.append(dialog);
  let mode=Math.max(0,modes.indexOf(localStorage.getItem('edge.'+service+'.visualizerMode')));
  let phase=0,last=0,hue=165;
  const levels=new Float32Array(32),envelope=new Float32Array(32);
  let animation=0,audioAt=0,latest=null;
  let bassFloor=0,accent=0,twist=0;
  const continuous=()=>mode===3||mode===6||mode===7||mode===8;
  // Capture each dot's launch velocity once; later transients affect new dots.
  const dots=Array.from({length:32*22},(_,i)=>({age:(i%22)/22,power:0,angle:Math.floor(i/22)*tau/32}));
  function animate(now){
    animation=0;
    if(!dialog.open||document.hidden||!latest||!continuous())return;
    const age=now-audioAt;
    const dt=last?Math.min(.05,(now-last)/1000):1/60;
    for(let i=0;i<32;i++){
      const target=age<220?latest[i]:0;
      const response=target>envelope[i] ? .12 : .36;
      envelope[i]+=(target-envelope[i])*(1-Math.exp(-dt/response));
    }
    render(envelope,now);
    if(age<1600)animation=requestAnimationFrame(animate);
  }
  function stopAnimation(){
    cancelAnimationFrame(animation);animation=0;latest=null;last=0;
  }
  function draw(frame){
    if(!continuous()){render(frame,performance.now());return}
    latest=frame;audioAt=performance.now();
    if(!animation)animation=requestAnimationFrame(animate);
  }
  // Render plasma at a small resolution and interpolate it across the panel.
  const field=el('canvas');field.width=260;field.height=88;
  const fieldCtx=field.getContext('2d'),pixels=fieldCtx.createImageData(field.width,field.height);
  const radii=new Float32Array(field.width*field.height);
  for(let y=0;y<field.height;y++)for(let x=0;x<field.width;x++)
    radii[y*field.width+x]=Math.hypot((x/field.width-.5)*2,y/field.height-.5)*14;
  const palette=Array.from({length:256},(_,i)=>[0,2.1,4.2].map(offset=>
    Math.round(255*Math.pow(.5+.5*Math.cos(i*tau/256+offset),2))));

  const particles=Array.from({length:220},(_,i)=>({
    angle:i*2.399963,depth:(i+.5)/220,radius:.12+.88*((i*37)%113)/113
  }));
  const keys=modes.map((name,index)=>{
    const b=button(name,()=>{select(index);showControls(false)});nav.append(b);return b;
  });
  function select(index){
    stopAnimation();mode=index;bassFloor=0;accent=0;twist=0;phase=0;levels.fill(0);envelope.fill(0);
    dots.forEach((dot,i)=>{dot.age=(i%22)/22;dot.power=0;dot.angle=Math.floor(i/22)*tau/32});
    localStorage.setItem('edge.'+service+'.visualizerMode',modes[index]);
    keys.forEach((b,i)=>b.setAttribute('aria-pressed',String(i===index)));
    ctx.fillStyle='#030605';ctx.fillRect(0,0,canvas.width,canvas.height);
  }
  let hideTimer;
  dialog.tabIndex=-1;
  function showControls(show,autoHide=true){
    clearTimeout(hideTimer);
    header.inert=nav.inert=!show;
    dialog.classList.toggle('sp-vis-controls',show);
    if(!show&&dialog.open)dialog.focus({preventScroll:true});
    if(show&&autoHide)hideTimer=setTimeout(()=>showControls(false),4800);
  }
  dialog.onclick=e=>{
    if(e.target.closest('button,nav,header'))return;
    showControls(nav.inert);
  };
  dialog.onpointerdown=()=>{if(!nav.inert)showControls(true)};
  dialog.onkeydown=e=>{
    if(e.key==='Tab')showControls(true,false);
    if(e.target===dialog&&(e.key==='Enter'||e.key===' ')){
      e.preventDefault();showControls(nav.inert,false);
    }
  };
  select(mode);showControls(false);
  const fitPanel=()=>window.frameElement?.dispatchEvent(new Event('dashboardfit'));
  dialog.onclose=()=>{stopAnimation();clearTimeout(hideTimer);dialog.remove();fitPanel();onClose()};
  dialog.showModal();fitPanel();dialog.focus({preventScroll:true});
  function render(frame,now){
    const scale=Math.min(devicePixelRatio||1,1920/Math.max(1,canvas.clientWidth),1080/Math.max(1,canvas.clientHeight));
    const w=Math.max(1,Math.round(canvas.clientWidth*scale)),h=Math.max(1,Math.round(canvas.clientHeight*scale));
    if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h}
    const dt=last?Math.min(.09,(now-last)/1000):.04;last=now;
    const bass=frame.slice(0,7).reduce((sum,v)=>sum+v,0)/(7*255);
    phase+=dt*(.28+1.35*bass);hue=(hue+dt*(7+17*bass))%360;
    const cx=w/2,cy=h/2,short=Math.min(w,h);
    const wave=i=>((frame[32+i]??128)-128)/127;
    if(mode===4){
      ctx.save();ctx.translate(cx,cy);ctx.rotate(.003+.009*bass);ctx.scale(1.014+.023*bass,1.015+.021*bass);
      ctx.drawImage(canvas,-cx,-cy);ctx.restore();
      ctx.fillStyle='rgba(3,5,9,.09)';ctx.fillRect(0,0,w,h);
    }else if(mode!==2){
      ctx.fillStyle=mode===6?'rgba(2,5,9,.42)':'#030605';ctx.fillRect(0,0,w,h);
    }
    if(mode===0){
      // Ease each measured band independently. Interpolation softens the
      // silhouette while keeping bass and treble in their original positions.
      for(let i=0;i<levels.length;i++){
        const target=frame[i]/255;
        const response=target>levels[i] ? .095 : .31;
        levels[i]+=(target-levels[i])*(1-Math.exp(-dt/response));
      }
      const count=96,width=w/(count+(count-1)*.4),step=width*1.4;
      const glow=ctx.createLinearGradient(0,0,0,h);
      glow.addColorStop(0,'#a5c5b3');glow.addColorStop(.55,'#689985');glow.addColorStop(1,'#35564e');
      for(let i=0;i<count;i++){
        const pos=i*31/(count-1),band=Math.floor(pos),mix=pos-band;
        const height=h*(levels[band]+(levels[Math.min(31,band+1)]-levels[band])*mix);
        if(height<.7)continue;
        const x=i*step;
        ctx.fillStyle=glow;ctx.beginPath();
        const radius=Math.min(width*.22,height*.5);
        ctx.roundRect(x,h-height,width,height,[radius,radius,0,0]);ctx.fill();
      }
    }else if(mode===1){
      ctx.strokeStyle='#152a24';ctx.lineWidth=1;ctx.beginPath();
      for(let i=1;i<16;i++){ctx.moveTo(i*w/16,0);ctx.lineTo(i*w/16,h)}
      for(let i=1;i<8;i++){ctx.moveTo(0,i*h/8);ctx.lineTo(w,i*h/8)}ctx.stroke();
      ctx.strokeStyle='#7affbd';ctx.lineWidth=2.5;ctx.shadowColor='#32df8b';ctx.shadowBlur=8;ctx.beginPath();
      for(let i=0;i<256;i++){const y=cy-h*.45*wave(i);if(i===0)ctx.moveTo(0,y);else ctx.lineTo(i*w/255,y)}
      ctx.stroke();ctx.shadowBlur=0;
    }else if(mode===2){
      const dy=Math.max(1,Math.ceil(dt*h*.22));
      ctx.drawImage(canvas,0,-dy);
      for(let i=0;i<32;i++){
        const amp=frame[i]/255;
        ctx.fillStyle='hsl('+(240-235*amp)+' 95% '+(2+62*amp)+'%)';
        ctx.fillRect(i*w/32,h-dy,Math.ceil(w/32),dy);
      }
    }else if(mode===3||mode===4){
      const rings=mode===3?22:4;
      for(let ring=0;ring<rings;ring++){
        const t=((ring/rings+phase*.22)%1),depth=t*t;
        const radius=mode===3?short*(.025+depth*1.65):short*(.08+ring*.041+bass*.06);
        const ox=cx+Math.sin(phase*1.4+t*3)*w*.12*(1-t),oy=cy+Math.cos(phase+t*3)*h*.15*(1-t);
        const opacity=mode===3?(.26+.67*t)*Math.min(1,t*12,(1-t)*12):.26+.67*t;
        ctx.strokeStyle='hsla('+((hue+ring*9)%360)+' 90% 64% / '+opacity+')';
        ctx.lineWidth=1+2*t;ctx.beginPath();
        for(let i=0;i<=128;i++){
          const a=i*tau/128+phase*.26+t*.8;
          const band=i/4,lo=Math.floor(band)%32,frac=band%1;
          const signal=mode===3?(frame[lo]*(1-frac)+frame[(lo+1)%32]*frac)/255:wave((i*2)%256);
          const r=radius*(1+.23*signal+.12*Math.sin(5*a+phase));
          const x=ox+Math.cos(a)*r*(mode===3?1.45:1.2),y=oy+Math.sin(a)*r;
          if(!i)ctx.moveTo(x,y);else ctx.lineTo(x,y);
        }
        ctx.closePath();ctx.stroke();
      }
    }else if(mode===5){
      for(const [i,p] of particles.entries()){
        const speed=.09+bass*.37,old=p.depth;p.depth-=dt*speed;if(p.depth<.035)p.depth+=1;
        const z=p.depth,trail=old<z?z:old,dx=Math.cos(p.angle)*w*.37*p.radius,dy=Math.sin(p.angle)*h*.4*p.radius;
        ctx.strokeStyle='hsl('+((hue+i*.33)%360)+' 75% '+(42+40*(1-z))+'%)';
        ctx.lineWidth=.7+2.8*(1-z);ctx.beginPath();ctx.moveTo(cx+dx/trail,cy+dy/trail);ctx.lineTo(cx+dx/z+1,cy+dy/z);ctx.stroke();
      }
    }else if(mode===6){
      for(let i=0;i<dots.length;i++){
        const dot=dots[i],band=Math.floor(i/22);
        dot.age+=dt*.74;
        if(dot.age>=1){
          dot.age-=1;dot.power=frame[band]/255;dot.angle=band*tau/32+phase*.23;
        }
        if(!dot.power)continue;
        const t=dot.age;
        const x=cx+w*.46*Math.cos(dot.angle)*t;
        const y=h*.88-h*3.4*t*(1-t)*(.22+.78*dot.power)+h*.12*Math.sin(dot.angle)*t;
        ctx.fillStyle='hsla('+((hue+band*5+t*65)%360)+' 82% '+(40+28*(1-t))+'% / '+Math.min(1,t*16,(1-t)*8)+')';
        ctx.beginPath();ctx.arc(x,y,1.2+2*t,0,tau);ctx.fill();
      }
    }else if(mode===7){
      for(let y=0;y<field.height;y++){
        const v=y/field.height,flow=Math.sin(v*8-phase*1.4);
        for(let x=0;x<field.width;x++){
          const u=x/field.width,band=u*31,lo=Math.floor(band),frac=band-lo;
          const energy=(frame[lo]*(1-frac)+frame[Math.min(31,lo+1)]*frac)/255;
          const fieldValue=Math.sin(u*12+flow*2+phase)+Math.cos(v*9+u*4-phase)
            +Math.sin(radii[y*field.width+x]-phase*2+bass*3);
          const color=palette[Math.floor(128+34*fieldValue+phase*18+energy*15)&255];
          const light=.35+.65*energy,index=(y*field.width+x)*4;
          pixels.data[index]=color[0]*light;pixels.data[index+1]=color[1]*light;
          pixels.data[index+2]=color[2]*light;pixels.data[index+3]=255;
        }
      }
      fieldCtx.putImageData(pixels,0,0);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(field,0,0,w,h);
    }else{
      const mid=frame.slice(8,21).reduce((sum,v)=>sum+v,0)/(13*255);
      const high=frame.slice(21,32).reduce((sum,v)=>sum+v,0)/(11*255);
      bassFloor+=(bass-bassFloor)*(1-Math.exp(-dt/.65));
      accent=Math.max(accent*Math.exp(-dt/.27),Math.min(1,4*Math.max(0,bass-bassFloor)));
      twist+=dt*(.12+mid*.83+accent*.46);
      const facets=12,wedge=tau/facets,radius=Math.hypot(cx,cy)+3;
      const iris=short*(.025+.17*bass+.065*accent);
      const ribbons=[];
      // Build one wedge from the live spectrum and mirror it across each seam.
      for(let layer=0;layer<6;layer++){
        const shape=new Path2D(),edge=new Path2D(),inside=[];
        for(let i=0;i<=72;i++){
          const t=i/72,bin=t*30,lo=Math.floor(bin);
          const energy=(frame[lo]+(frame[lo+1]-frame[lo])*(bin-lo))/255;
          const spiral=phase*(.7+layer*.09)+layer*1.91+t*(8+6*mid);
          const center=.5+.43*Math.sin(spiral+energy*2.1+Math.sin(4*t-twist)*1.3);
          const width=.012+.09*energy+.065*(layer%2?high:accent);
          const r=iris*(layer+1)/6+t*radius;
          const top=wedge*Math.min(1,center+width),bottom=wedge*Math.max(0,center-width);
          const x=r*Math.cos(top),y=r*Math.sin(top);
          if(i){shape.lineTo(x,y);edge.lineTo(x,y)}else{shape.moveTo(x,y);edge.moveTo(x,y)}
          inside.push([r*Math.cos(bottom),r*Math.sin(bottom)]);
        }
        for(let i=inside.length-1;i>=0;i--)shape.lineTo(...inside[i]);
        shape.closePath();
        const color=hue+layer*33+90*mid+55*accent;
        ribbons.push({shape,edge,fill:'hsla('+color+' 84% '+(31+13*bass)+'% / .76)',
          stroke:'hsla('+(color+22)+' 87% '+(56+24*high)+'% / '+(.46+.49*high)+')'});
      }
      ctx.save();ctx.translate(cx,cy);ctx.rotate(twist*.32);
      for(let facet=0;facet<facets;facet++){
        ctx.save();
        ctx.rotate((facet+(facet%2))*wedge);
        if(facet%2)ctx.scale(1,-1);
        for(const ribbon of ribbons){
          ctx.fillStyle=ribbon.fill;ctx.fill(ribbon.shape);
          ctx.strokeStyle=ribbon.stroke;ctx.lineWidth=1+2*high;ctx.stroke(ribbon.edge);
        }
        ctx.restore();
      }
      ctx.restore();
    }
  }
  return {draw,get decaysOnSilence(){return mode===0},close:()=>dialog.close(),update(title,artist){track.textContent=[title,artist].filter(Boolean).join(' · ')},message(text){if(text&&continuous())stopAnimation();status.textContent=text;status.hidden=!text}};
}
