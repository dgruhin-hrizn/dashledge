import {timeText,unpack} from './model.js';
import {drawPinballClock} from './pinball.js';

const digits=[
  [14,17,19,21,25,17,14],[4,12,4,4,4,4,14],[14,17,1,2,4,8,31],[30,1,1,14,1,1,30],
  [2,6,10,18,31,2,2],[31,16,16,30,1,1,30],[14,16,16,30,17,17,14],[31,1,2,4,8,8,8],
  [14,17,17,14,17,17,14],[14,17,17,15,1,1,14]
];
const glyphs={':':[0,1,1,0,1,1,0],' ':[0,0,0,0,0,0,0],A:[14,17,17,31,17,17,17],P:[30,17,17,30,16,16,16],M:[17,27,21,21,17,17,17]};
function surface(w,h){const c=document.createElement('canvas');c.width=w;c.height=h;return c}
function widthOf(c){return c===':'||c===' '?1:5}
// The card carries animation art. These clock faces are drawn locally.
const faceNames=['Pinball','Heavy metal','Rock','Chrome','Sport','Comic','Space','Player','Zombie','Digital','Darthboman','Heroes','Adventure','Axe','Celebration','Twilight','Magic','Pirate','CM-5 inspired','Random'];
export const styles=faceNames.map(name=>[name.toLowerCase().replace(/ /g,'-'),name]);
export const analogStyles=['twilight','magic','pirate'];
const designs={
  'heavy-metal':{shine:[1,.9,.8,.65,.55,.48,.4],bevel:true},rock:{cut:true,bevel:true},chrome:{shine:[.8,1,.94,.45,.6,.78,.95]},
  sport:{lean:true},comic:{lean:true,bevel:true},space:{stripe:true},player:{stripe:true,bevel:true},
  zombie:{cut:true,shine:[1,.9,.8,.68,.52,.37,.24]},digital:{cut:true},darthboman:{stencil:true,shine:[.65,.8,1,.7,.85,.65,.5]},
  heroes:{bevel:true,shine:[1,1,.9,.85,.75,.8,1]},adventure:{lean:true,cut:true},axe:{lean:true,stencil:true},
  celebration:{shine:[1,.65,1,.75,1,.65,1],bevel:true}
};
function digital(ctx,s,x,y,scale,style,sep,shade){
  const design=designs[style]||{};
  const ink=level=>'rgb('+[level,level,level].join(',')+')';
  for(const c of s){
    const width=widthOf(c),rows=digits[c]||glyphs[c];
    if(c!==':'||sep)for(let r=0;r<7;r++)for(let col=0;col<width;col++){
      if(!(rows[r]&(1<<(width-1-col))))continue;
      const left=x+col*scale+(design.lean?Math.floor((6-r)*scale/5):0),top=y+r*scale;
      ctx.fillStyle=ink(Math.round(shade*(design.shine?.[r]??1)));
      ctx.fillRect(left,top,scale,design.stripe&&scale>1?scale-1:scale);
      if(scale>1){
        if(design.cut)ctx.clearRect(left,top,1,1);
        if(design.bevel){ctx.fillStyle=ink(Math.round(shade*.45));ctx.fillRect(left,top+scale-1,scale,1)}
        if(design.stencil&&r===3)ctx.clearRect(left,top,scale,1);
      }
    }
    x+=(width+1)*scale;
  }
}
function clock(ctx,date,p,opts={}){
  if(p.keyText&&!opts.small){
    const value=p.keyText.replaceAll('{time}',timeText(date,p.format));
    const fontsize=Math.min(16,Math.max(8,Math.floor(200/value.length)));
    text(ctx,value,Math.max(0,64-value.length*fontsize*.3),Math.floor((32-fontsize)/2),fontsize,p.keyStyle==='enhanced'?'enhanced':'plain');
    return;
  }
  const s=timeText(date,p.format),sep=p.dots==='on'||(p.dots==='blink'&&(date.getSeconds()&1)===0);
  const units=[...s].reduce((n,c)=>n+widthOf(c)+1,-1),scale=opts.small?1:Math.min(4,Math.floor(126/units));
  const shade=Math.round(Number(p.shade)*17);
  if(p.style==='pinball'&&!opts.small){
    drawPinballClock(ctx,s,sep,shade);
    return;
  }
  const x=opts.small?opts.x:Math.floor((128-units*scale)/2),y=opts.small?opts.y:Math.floor((32-7*scale)/2);
  if(analogStyles.includes(p.style)&&!opts.small){
    ctx.save();ctx.translate(64,16);ctx.strokeStyle='rgb('+[shade,shade,shade].join(',')+')';ctx.lineWidth=1;
    if(p.style==='magic'){ctx.beginPath();ctx.arc(0,0,15,0,2*Math.PI);ctx.stroke()}
    if(p.style==='pirate'){
      ctx.beginPath();for(let i=0;i<=16;i++){const a=i*Math.PI/8,len=i%2?10:15,x=len*Math.sin(a),y=len*Math.cos(a);if(i)ctx.lineTo(x,y);else ctx.moveTo(x,y)}ctx.stroke();
    }
    for(let i=0;i<12;i++){const a=i*Math.PI/6;ctx.fillStyle=ctx.strokeStyle;ctx.fillRect(Math.round(Math.sin(a)*14),Math.round(-Math.cos(a)*14),1,1)}
    const hand=(angle,len,w)=>{ctx.lineWidth=w;ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(Math.sin(angle)*len,-Math.cos(angle)*len);ctx.stroke()};
    hand((date.getHours()%12+date.getMinutes()/60)*Math.PI/6,8,2);hand(date.getMinutes()*Math.PI/30,12,1.5);
    if(p.format.endsWith('s')||p.dots==='blink')hand(date.getSeconds()*Math.PI/30,13,1);
    ctx.restore();return;
  }
  digital(ctx,s,x,y,scale,p.style,sep,shade);
}
function text(ctx,value,x,y,size=9,style='plain'){
  ctx.font='bold '+size+'px monospace';ctx.textBaseline='top';
  if(style==='shadow'||style==='enhanced'){ctx.fillStyle='#000';ctx.fillText(value,Math.round(x+1),Math.round(y+1))}
  ctx.fillStyle=style==='enhanced'?'#ddd':'#fff';ctx.fillText(value,Math.round(x),Math.round(y));
}
const positions={top:0,high:5,middle:11,low:17,bottom:22};
export const speeds={slowest:12,slow:22,normal:38,fast:62,faster:90,insane:145};
export function messageDuration(s,speed){return (128+s.length*6)/speeds[speed]*1000}
function message(ctx,scene,elapsed,p){
  const value=scene.text,len=value.length*6,distance=elapsed/1000*speeds[p.scroll],mode=scene.move;
  let x=128-distance,y=scene.y;
  if(mode==='static'||mode==='vertical')x=Math.max(0,(128-len)/2);
  if(mode==='vertical')y=32-(distance%(32+10));
  if(mode==='bounce'){const span=Math.max(1,Math.abs(128-len));x=Math.min(0,128-len)+Math.abs((distance%(2*span))-span)}
  if(mode==='diagonal'||mode==='loop')y=11+Math.sin(distance/(mode==='loop'?12:24))*10;
  text(ctx,value,x,y,9,p.textStyle);
}
export function prepareMessage(value,p){
  const choices=['horizontal','bounce','loop','diagonal',...(value.length<22?['static','vertical']:[])];
  const random=a=>a[Math.floor(Math.random()*a.length)];
  return {text:value,move:p.move==='random'?random(choices):p.move,y:p.position==='random'?Math.floor(Math.random()*24):positions[p.position],
    layer:p.textClock==='random'?random(['front','behind']):p.textClock};
}
// Stern 520-5052-15 uses 20 mm, 8-by-8 LED modules (112-0073-00).
const pitchMm=2.5, dotMm=1.9;
export function matrixGeometry(width,height){
  const pitchX=width/128,pitchY=height/32;
  return {pitchX,pitchY,radius:Math.min(pitchX,pitchY)*dotMm/(2*pitchMm)};
}

export function createDisplay(canvas){
  const layer=surface(128,32),ctx=layer.getContext('2d',{willReadFrequently:true});
  const screen=surface(128,32),sctx=screen.getContext('2d'),rgba=sctx.createImageData(128,32);
  const pixels=new Uint8Array(4096),mapped=new Uint8Array(4096);
  const mask=surface(1,1),maskCtx=mask.getContext('2d');
  const out=canvas.getContext('2d');
  function resize(width,height){
    if(mask.width===width&&mask.height===height&&canvas.width===width&&canvas.height===height)return;
    canvas.width=mask.width=width;canvas.height=mask.height=height;
    const {pitchX,pitchY,radius}=matrixGeometry(width,height);
    maskCtx.fillStyle='#fff';
    maskCtx.beginPath();
    for(let row=0;row<32;row++){
      const y=(row+.5)*pitchY;
      for(let col=0;col<128;col++){
        const x=(col+.5)*pitchX;
        maskCtx.moveTo(x+radius,y);
        maskCtx.arc(x,y,radius,0,2*Math.PI);
      }
    }
    maskCtx.fill();
  }
  resize(1024,256);
  function render(date,p,scene={}){
    ctx.clearRect(0,0,128,32);mapped.fill(0);
    const {clip,frame,elapsed=0}=scene;
    if(scene.asleep){canvas.parentElement.style.background='';out.clearRect(0,0,canvas.width,canvas.height);return}
    if(scene.board){
      const b=scene.board;
      text(ctx,b.title.toUpperCase(),1,0,7);
      const count=b.index+'/'+b.total;text(ctx,count,127-count.length*4.2,0,7);
      if(!b.basic){ctx.fillStyle='#555';ctx.fillRect(0,8,128,1)}
      const fs=Math.min(11,Math.max(6,Math.floor(212/Math.max(1,b.label.length))));
      text(ctx,b.label.toUpperCase(),1,11,fs);text(ctx,b.info||'C:EXIT   A:<   B:>   D:OK',1,24,7);
    }else if(scene.cm5){
      const tick=Math.floor(date.getTime()/100);
      for(let y=0;y<32;y++)for(let x=0;x<128;x++){
        const lane=Math.floor(y/4),cluster=Math.floor(x/16);
        if(y%4!==3&&x%16!==15&&((x+(tick>>(lane%3))+cluster*3)%(5+lane%4))<2)mapped[y*128+x]=7+(lane+cluster)%9;
      }
      ctx.fillStyle='black';ctx.fillRect(47,10,34,12);
      digital(ctx,timeText(date,'24'),51,12,1,'pinball',true,255);
    }else if(scene.test){
      for(let i=0;i<4096;i++)mapped[i]=[Math.floor((i%128)/8),(i+Math.floor(i/128)+Math.floor(elapsed/160))%2*15,15][Math.floor(elapsed/1500)%3];
    }else if(scene.splash){
      const rows=scene.splash.length/64;
      const row=Math.max(0,Math.min(rows-32,Math.floor((elapsed-500)/28)));
      const pad=Math.max(0,Math.floor((32-rows)/2));
      for(let y=pad;y<Math.min(32,pad+rows);y++)for(let x=0;x<128;x++){const b=scene.splash[(y-pad+row)*64+(x>>1)];mapped[y*128+x]=x&1?b&15:b>>4}
    }else if(clip){
      unpack(clip.pixels,clip.frames[frame].bitmap,pixels);
      const layerMode=p.overlay==='auto'?(frame>=clip.first&&frame<=clip.last?clip.layer:0):({front:2,back:1,off:0})[p.overlay];
      if(layerMode)clock(ctx,date,p,clip);
      const data=ctx.getImageData(0,0,128,32).data;
      for(let i=0;i<4096;i++){
        const dot=pixels[i],ink=Math.round(data[4*i]*data[4*i+3]/(255*17));
        const art=clip.fourShade?(dot===1?4:dot===3?9:dot):dot;
        mapped[i]=layerMode===2&&ink?ink:dot===10?(layerMode===1?ink:0):art;
      }
      ctx.clearRect(0,0,128,32);
      if(p.names==='during')text(ctx,scene.name,1,23,8,'shadow');
    }else if(scene.banner){text(ctx,scene.banner,128-elapsed/1000*55,11,10)}
    else if(scene.message){
      if(scene.message.layer==='behind')clock(ctx,date,p);
      message(ctx,scene.message,elapsed,p);
      if(scene.message.layer==='front')clock(ctx,date,p);
    }else{
      ctx.save();ctx.translate(0,scene.shift||0);ctx.globalAlpha=scene.alpha??1;clock(ctx,date,p);ctx.restore();
    }
    const overlay=ctx.getImageData(0,0,128,32).data;
    const rgb=[1,3,5].map(i=>parseInt(p.color.slice(i,i+2),16));
    const bright={low:.42,medium:.82,high:1}[p.brightness];
    const gamma=clip?(p.contrast==='enhanced'?.60:.80):(p.contrast==='enhanced'?1.5:.88);
    const lut=Array.from({length:16},(_,level)=>{
      const gain=Math.pow(level/15,gamma)*bright;
      return rgb.map((c,k)=>Math.round([21,14,11][k]+(c-[21,14,11][k])*gain));
    });
    let energy=0;
    for(let i=0;i<4096;i++){
      const alpha=overlay[i*4+3]/255;
      const v=Math.min(15,Math.round(mapped[i]*(1-alpha)+(overlay[i*4]/17)*alpha)),color=lut[v];
      energy+=v;const j=i*4;rgba.data[j]=color[0];rgba.data[j+1]=color[1];rgba.data[j+2]=color[2];rgba.data[j+3]=255;
    }
    const host=canvas.parentElement;
    if(host&&host.classList.contains('dmd-screen')){
      const glow=p.ambient==='panel'?p.color:p.ambient;
      host.style.background=glow==='off'?'':'radial-gradient(ellipse at center,'+glow+Math.round(20+energy/61440*120).toString(16).padStart(2,'0')+',#080807 86%)';
    }
    sctx.putImageData(rgba,0,0);
    out.globalCompositeOperation='copy';out.imageSmoothingEnabled=false;
    out.drawImage(screen,0,0,canvas.width,canvas.height);
    out.globalCompositeOperation='destination-in';out.drawImage(mask,0,0);
    out.globalCompositeOperation='source-over';
  }
  return {render,resize};
}
