// The same three-place integer column and one decimal used by oMLX Live Decode.
const formatter=new Intl.NumberFormat(undefined,{minimumFractionDigits:1,maximumFractionDigits:1,useGrouping:false});
const rates=['B/s','KB/s','MB/s','GB/s','TB/s'];
export function measurement(value,kind){
  if(!Number.isFinite(value))return {integer:'—',fraction:'',unit:'',scaled:null};
  let scaled=value,unit='%';
  if(kind==='memory'){scaled=value/2**30;unit='GiB'}
  if(kind==='rate'){
    let i=0;
    // Promote values that round to 1000.0 before they can overflow the three columns.
    while(scaled>=999.95&&i<rates.length-1){scaled/=1000;i++}
    unit=rates[i];
  }
  const parts=formatter.formatToParts(scaled);
  return {integer:value===0?'00':parts.find(p=>p.type==='integer').value,
    fraction:parts.filter(p=>p.type==='decimal'||p.type==='fraction').map(p=>p.value).join(''),unit,scaled};
}
export function animateReading(paint,clock){
  let shown=null,target=null,frame=null,lastUpdate=-Infinity;
  function stop(){if(frame!=null)clock.cancel(frame);frame=null}
  function show(n){shown=n;paint(n)}
  return {
    update(value,unitKind){
      const n=Number.isFinite(value)?value:null,now=clock.now();
      const stale=now-lastUpdate>2000;lastUpdate=now;
      if(n===target&&shown!==null&&!stale&&!clock.immediate())return;
      stop();target=n;
      const before=measurement(shown,unitKind),after=measurement(n,unitKind);
      if(n==null||shown==null||clock.immediate()||stale||
         (before.unit===after.unit&&Math.abs(after.scaled-before.scaled)<1)){show(n);return}
      const from=shown,start=now,interval=n===0?80:125;
      let lastPaint=start;
      function step(time){
        const progress=Math.min(1,Math.max(0,(time-start)/800));
        if(progress===1||clock.immediate()){frame=null;show(n);return}
        if(time-lastPaint>=interval){
          const eased=progress*progress*(3-2*progress);
          show(from+(n-from)*eased);lastPaint=time;
        }
        frame=clock.request(step);
      }
      frame=clock.request(step);
    },
    stop,
  };
}
export function createReading(label,kind){
  const root=document.createElement('div');root.className='reading numeric-reading';
  const digits=document.createElement('strong'),integer=document.createElement('span'),fraction=document.createElement('span'),unit=document.createElement('span');
  integer.className='integer';fraction.className='fraction';unit.className='unit';
  digits.append(integer,fraction);root.append(digits,unit);
  root.setAttribute('role','img');digits.setAttribute('aria-hidden','true');unit.setAttribute('aria-hidden','true');
  const motion=window.matchMedia('(prefers-reduced-motion: reduce)');
  const runner=animateReading(n=>{
    const m=measurement(n,kind);
    integer.textContent=m.integer;fraction.textContent=m.fraction;unit.textContent=m.unit;
  },{now:()=>performance.now(),request:cb=>requestAnimationFrame(cb),cancel:id=>cancelAnimationFrame(id),immediate:()=>motion.matches||document.hidden});
  return {root,stop:runner.stop,update(n){
    const m=measurement(n,kind);
    root.setAttribute('aria-label',label+' '+m.integer+m.fraction+' '+m.unit);
    runner.update(n,kind);
  }};
}
