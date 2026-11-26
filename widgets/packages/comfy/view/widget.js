(() => {
  const wall=document.querySelector('main'),detail=document.querySelector('#detail'),jobs=document.querySelector('#jobs');
  const el=(tag,cls='',text='')=>Object.assign(document.createElement(tag),{className:cls,textContent:text});
  const gib=n=>(n/2**30).toFixed(1);
  let data,open=null,reveal=null,hideTimer,loading=false;
  function conceal(){
    clearTimeout(hideTimer);reveal=null;
    for(const button of wall.querySelectorAll('.preview')){
      button.querySelector('img')?.remove();button.setAttribute('aria-pressed','false');
      const caption=button.querySelector('b');if(caption)caption.textContent=button.disabled?'No output yet':'Tap to reveal';
    }
  }
  function go(index){conceal();open=index;wall.hidden=index!==null;detail.hidden=index===null;draw();}
  document.querySelector('#back').onclick=()=>go(null);
  function card(i){
    const item=el('article'),head=el('div','heading'),name=el('h2'),badge=el('span','badge');
    const address=el('small','address');head.append(name,address,badge);const body=el('div','body'),preview=el('button','preview');
    preview.setAttribute('aria-pressed','false');
    preview.append(el('i','shutter'),el('span','photo-label','LATEST OUTPUT'),el('b','','Tap to reveal'));
    const readings=el('div','readings'),node=el('strong'),step=el('small'),track=el('div','track');
    track.append(el('i'));const gpu=el('div','gpu'),queue=el('button','queue');
    const load=el('span','gpu-load'),percent=el('b');
    load.hidden=true;load.append(percent);
    load.title='Worker GPU utilization (highest GPU load)';
    load.setAttribute('role','meter');load.setAttribute('aria-label',load.title);
    load.setAttribute('aria-valuemin','0');load.setAttribute('aria-valuemax','100');
    readings.append(node,step,track,gpu,queue);body.append(preview,readings);item.append(head,body);
    queue.onclick=()=>go(i);
    preview.onclick=()=>{
      const expected=data?.workers?.[i]?.preview;
      if(reveal?.i===i){conceal();return;}
      conceal();
      if(document.hidden||open!==null||!valid(expected,i)||Date.now()-data.at>45000)return;
      reveal={i,expected};const img=new Image();img.alt='Latest output';img.onerror=()=>{if(reveal?.i===i&&reveal.expected===expected)conceal();};
      img.src='previews/'+expected;preview.append(img);preview.setAttribute('aria-pressed','true');
      preview.querySelector('b').textContent='Tap to hide';hideTimer=setTimeout(conceal,15000);
    };
    return {item,name,address,badge,node,step,track,gpu,queue,preview,head,load,percent};
  }
  const cards=[card(0),card(1)];wall.append(...cards.map(c=>c.item));
  function valid(file,i){return typeof file==='string'&&new RegExp('^'+i+'-[a-f0-9]{20}\\.jpg$').test(file);}
  function memoryRow(label,total,free){
    if(!Number.isFinite(total)||total<=0||!Number.isFinite(free))return null;
    const used=Math.max(0,Math.min(total,total-free)),row=el('div','hw-meter');
    const meter=el('meter');meter.max=total;meter.value=used;meter.setAttribute('aria-label',label+' used');
    row.append(el('span','',label),meter,el('span','amount',gib(used)+' / '+gib(total)+' GiB'));
    return row;
  }
  function devicePanel(d,system={},load){
    const raw=String(d.name||'Accelerator');
    const prefix=raw.match(/^(cuda|xpu|hip|rocm):(\d+)\s+/i);
    const type=String(d.type||prefix?.[1]||'').toLowerCase();
    const allocator=raw.match(/\s+:\s+(\S+)\s*$/)?.[1];
    const model=raw.replace(/^(cuda|xpu|hip|rocm):\d+\s+/i,'').replace(/\s+:\s*\S*\s*$/,'').trim();
    const rocm=['hip','rocm'].includes(type)||(type==='cuda' && /rocm/i.test(system.torch||''));
    let vendor='',backend='';
    if(type!=='cpu'){
      if(type==='xpu'||/\bIntel\b/i.test(model))vendor='Intel';
      else if(rocm||/\b(AMD|Radeon|Instinct)\b/i.test(model))vendor='AMD';
      else if(/\bNVIDIA\b/i.test(model))vendor='NVIDIA';
    }
    if(type==='xpu')backend='XPU';
    else if(rocm)backend='ROCm';
    const panel=el('section','accelerator'),head=el('div','accelerator-head');
    panel.dataset.vendor=vendor;
    if(vendor==='NVIDIA'){
      const logo=el('img','nvidia');logo.src='nvidia.svg';logo.alt='NVIDIA';head.append(logo);
    }
    else if(vendor)head.append(el('b','gpu-vendor',vendor));
    if(backend)head.append(el('span','backend-badge',backend));
    if(vendor==='NVIDIA'&&type==='cuda'){
      const badge=el('span','cuda-badge'),logo=el('img');
      logo.alt='CUDA';logo.src='cuda.jpg';logo.onerror=()=>logo.remove();
      badge.append(el('span','','CUDA'),logo);head.append(badge);
    }
    if(load)head.append(load);
    panel.append(head,el('h3','',model.replace(/^(NVIDIA|AMD|Intel)(?:\(R\))?\s+/i,'')||raw));
    const metadata=[prefix?'Device '+prefix[2]:Number.isInteger(d.index)?'Device '+d.index:null,allocator,system.torch?'Torch '+system.torch:null].filter(Boolean);
    if(metadata.length)panel.append(el('small','runtime',metadata.join(' · ')));
    for(const row of [memoryRow(vendor==='AMD'||vendor==='Intel'?'GPU RAM':'VRAM',d.total,d.free),memoryRow('Host RAM',system.ram,system.ramFree)])if(row)panel.append(row);
    return panel;
  }
  function utilization(w){
    const reading=w.gpuLoad;
    return w.status!=='Offline' && Date.now()-reading?.at<=15000 ? reading.percent : null;
  }
  function busyGPU(w){return w.status==='Idle' && !w.active && utilization(w)>5;}
  function draw(){
    const workers=data?.workers||[],stale=data&&Date.now()-data.at>45000;
    document.querySelector('#summary').textContent=!data?'Waiting for capture':stale?'Last reading':workers.filter(w=>w.status==='Rendering'||busyGPU(w)).length+' rendering · '+workers.reduce((n,w)=>n+(w.queued||0),0)+' queued';
    cards.forEach((c,i)=>{
      const w=workers[i]||{},j=w.active;
      const load=stale?null:utilization(w),busy=!stale && busyGPU(w);
      c.load.hidden=load==null;
      if(load!=null){
        c.load.style.setProperty('--load',load+'%');c.percent.textContent=Math.round(load)+'%';
        c.load.setAttribute('aria-valuenow',String(load));
      }
      const status=busy?'Rendering':w.status;
      c.name.textContent=w.name||'Worker '+(i+1);c.item.dataset.state=stale?'Stale':status||'Connecting';
      c.address.textContent=w.host||'';
      c.badge.textContent=stale?'Last reading':status||'Connecting';
      c.node.textContent=j?.node||(j?'Workflow running':busy?'Rendering':w.status==='Idle'?'Ready to render':w.status==='Offline'?'Server unreachable':'Awaiting queue');
      const p=j?.progress;c.step.textContent=p?'Node step '+p[0]+' of '+p[1]:j?j.steps+' workflow nodes':busy?'GPU activity outside the queue':'';
      c.track.firstChild.style.width=p?Math.min(100,100*p[0]/p[1])+'%':'0%';c.track.hidden=!j&&!busy;
      c.track.classList.toggle('indeterminate',busy);
      const devices=w.devices||[], signature=JSON.stringify([devices,w.hardware]);
      if(c.gpu.dataset.devices!==signature){
        c.gpu.dataset.devices=signature;
        c.gpu.replaceChildren(...devices.map((d,index)=>devicePanel(d,w.hardware,index===0?c.load:null)));
      }
      if(!devices.length && c.load.parentElement!==c.head)c.head.append(c.load);
      c.queue.textContent='View queue';
      c.queue.dataset.count=w.queued??'—';
      c.queue.setAttribute('aria-label','View '+c.name.textContent+' queue, '+(w.queued??'unknown')+' pending');
      c.preview.disabled=stale||!valid(w.preview,i)||w.status==='Offline';
      if(reveal?.i===i && (reveal.expected!==w.preview||c.preview.disabled))conceal();
      if(reveal?.i!==i)c.preview.querySelector('b').textContent=c.preview.disabled?'No preview':'Tap to reveal';
    });
    if(open!==null){
      const w=workers[open]||{},top=jobs.scrollTop;
      detail.querySelector('h2').textContent=(w.name||'Worker')+' · Queue';
      const entries=[];
      function line(label,id,info){const r=el('div','row');r.append(el('b','',label),el('code','',id.slice(0,8)),el('small','',info));entries.push(r);}
      if(w.active)line('Running',w.active.id,w.active.node||'Workflow');
      for(const [i,j] of (w.pending||[]).entries())line('Queued '+(i+1),j.id,j.steps+' nodes');
      if(w.queued>w.pending?.length)entries.push(el('small','',w.queued-w.pending.length+' more queued'));
      for(const j of w.recent||[])line('Recent',j.id,j.status);
      jobs.replaceChildren(...(entries.length?entries:[el('p','',w.error||'No jobs recorded')]));jobs.scrollTop=top;
    }
  }
  window.comfySnapshot=s=>{if(Array.isArray(s?.workers)){data=s;draw();}};
  function refresh(){
    if(document.hidden||loading)return;draw();loading=true;
    const script=document.createElement('script');const done=()=>{clearTimeout(timer);script.remove();loading=false;};
    const timer=setTimeout(done,3000);script.onload=script.onerror=done;script.src='snapshot.js?t='+Date.now();document.head.append(script);
  }
  window.addEventListener('blur',conceal);window.addEventListener('pagehide',conceal);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)conceal();else refresh();});
  refresh();setInterval(refresh,1500);
})();
