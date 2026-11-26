// Each path closes at its starting pose with zero velocity. The opposite
// phases and different periods keep neighboring photographs from moving as a unit.
const paths=[
  [[-6,4,.95,-.7],[3,-3,1.06,.4],[7,1,1.035,.8],[-6,4,.95,-.7]],
  [[4,-3,.88,.8],[-5,5,.95,-.6],[-8,1,.92,-.8],[4,-3,.88,.8]],
  [[-3,4,.90,-.4],[6,-2,1,.7],[3,-6,.97,.3],[-3,4,.90,-.4]]
];
export function daydreamFrames(lane,right){
  const sign=right?1:-1;
  return paths[lane%paths.length].map(([x,y,scale,rotation],index)=>({
    offset:[0,.43,.68,1][index],
    transform:`translate3d(${x*sign}%,${y}%,0) rotate(${rotation*sign}deg) scale(${scale})`,
    easing:'cubic-bezier(.42,0,.42,1)'
  }));
}

export function daydreamCount(aspect){
  if(aspect>=3)return 9;
  if(aspect>=2)return 7;
  if(aspect>=1.35)return 5;
  return aspect>=.65?3:2;
}

// One tall focal image, with offset pairs filling the space on either side.
// Allocate complete columns even when a small album supplies fewer images.
function compose(panel,aspect){
  const frames=Array.from(panel.children);
  const count=frames.length;
  const slots=[];
  function place(x,y,w,h){slots.push({x,y,w,h,ratio:w*aspect/h})}
  if(count<=2){
    for(let i=0;i<count;i++)place(100*i/count+1,5,100/count-2,90);
  }else{
    const left=Math.ceil((count-1)/2),right=count-1-left;
    const hero=count<=5?40:26;
    const side=(100-hero)/2;
    place(side-1,4,hero+2,93);
    function wing(start,photos,mirror){
      const columns=Math.ceil(photos/2);
      for(let i=0;i<columns;i++){
        const w=side/columns,x=start+i*w;
        if(photos-2*i===1){place(x,.5,w,98);continue}
        const cut=(i+mirror)%2?58:43;
        place(x,.8,w+.6,cut);
        place(x,cut+2,w+.6,98-cut);
      }
    }
    wing(0,left,0);wing(100-side,right,1);
  }
  // Match portraits and landscapes to openings before applying a gentle crop.
  for(const [i,slot] of slots.entries()){
    const score=f=>Math.abs(Math.log(Number(f.firstElementChild.dataset.ratio)/slot.ratio));
    frames.sort((a,b)=>score(a)-score(b));
    const frame=frames.shift();
    frame.dataset.lane=i;frame.dataset.ratio=slot.ratio;
    Object.assign(frame.style,{left:slot.x+'%',top:slot.y+'%',width:slot.w+'%',height:slot.h+'%',zIndex:i===0?'3':String(1+i%2)});
    panel.append(frame);
  }
}

export function startDaydream(panel,{right,speed},nextPhoto){
  compose(panel,panel.parentElement.clientWidth/Math.max(1,panel.parentElement.clientHeight));
  const duration={slow:54000,medium:42000,fast:32000}[speed]||54000;
  const animations=new Set();
  let running=false,disposed=false;
  function register(animation){
    animations.add(animation);
    if(!running)animation.pause();
    return animation;
  }
  function release(animation){animations.delete(animation);animation.cancel()}
  for(const [lane,frame] of Array.from(panel.children).entries()){
    const period=duration*(lane===0?1:.88+(lane*7%19)*.018);
    const path=register(frame.animate(daydreamFrames(lane,right),{duration:period,iterations:Infinity}));
    const phase=(.16+lane*.381966)%1;
    path.currentTime=period*phase;
    // Changes happen between passes, at different times for each photograph.
    function schedule(first){
      const wait=register(frame.animate([{},{}],{duration:period*(first?1-phase:1)}));
      wait.onfinish=()=>{
        release(wait);
        if(disposed)return;
        const next=nextPhoto(Number(frame.dataset.ratio));
        if(next){
          const old=frame.firstElementChild;
          const img=next.firstElementChild;
          frame.append(img);
          const fade={duration:2400,easing:'ease-in-out',fill:'both'};
          const outgoing=register(old.animate([{opacity:1},{opacity:0}],fade));
          const blend=register(img.animate([{opacity:0},{opacity:1}],fade));
          blend.onfinish=()=>{old.remove();release(outgoing);release(blend)};
        }
        schedule(false);
      };
    }
    schedule(true);
  }
  return {
    setRunning(value){
      if(value===running)return;
      running=value;
      for(const animation of animations){if(value)animation.play();else animation.pause()}
    },
    dispose(){disposed=true;for(const animation of animations)animation.cancel();animations.clear()}
  };
}
