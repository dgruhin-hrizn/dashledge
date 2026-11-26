(() => {
  const $=id=>document.getElementById(id);
  const txt=(id,value)=>{if($(id).textContent!==value)$(id).textContent=value};
  const make=(tag,text='',cls='')=>Object.assign(document.createElement(tag),{textContent:text,className:cls});
  const fmt=(v,d=0)=>Number.isFinite(v)?v.toLocaleString(undefined,{maximumFractionDigits:d}):'—';
  const rate=v=>Number.isFinite(v)?fmt(v*8/1e6,2)+' Mbps':'—';
  const pct=v=>fmt(v,1)+'%';
  const tb=v=>fmt(v/1e12,1);
  const missing=d=>d.status==='DISK_NP';
  function problem(d){
    if(/fail/i.test(d.smart_status||''))return 'SMART failed';
    if(d.smart_errors>0)return fmt(d.smart_errors)+' SMART errors';
    if(d.status && !['DISK_OK','DISK_NP'].includes(d.status))return d.status;
    return '';
  }
  const severity=d=>problem(d)?2:missing(d)?1:0;
  const groups=['Array data','Array parity','Pool devices','Other devices'];
  const group=d=>globalThis.unraidAssignment(d);
  const speed=v=>Number.isFinite(v)?fmt(v/1e6,2)+' MB/s':'—';
  const order=(a,b)=>severity(b)-severity(a)||a.name.localeCompare(b.name,undefined,{numeric:true});
  let sample,page='',last,loading=false;
  const val=k=>sample?.sections?.[k]?.value;
  const setPage=p=>{page=p;$('overview').hidden=!!p;$('inspector').hidden=!p;$('rows').scrollTop=0;draw(true)};
  $('disk-open').onclick=()=>setPage('Disk inventory');
  $('alerts-open').onclick=()=>setPage('Disk health');
  $('docker-open').onclick=()=>setPage('Docker containers');
  $('close').onclick=()=>setPage('');
  const metricButtons=[...document.querySelectorAll('.metric')];
  for(const button of metricButtons){
    button.onclick=()=>{
      txt('period',button.querySelector('#read,#poolRead')?'Last 30 min':'Last 5 min');
      for(const other of metricButtons)other.setAttribute('aria-pressed',String(other===button));
    };
  }
  function row(name,detail,reading,cls=''){
    const r=make('div','','row '+cls),left=make('div');left.append(make('b',name),make('small',detail));r.append(left,make('span',reading));return r;
  }
  function inspect(disks,containers){
    txt('title',page);
    const docker=page==='Docker containers',items=docker?containers:disks;
    const rows=$('rows'),top=rows.scrollTop;
    const diskRow=d=>{
      const point=sample.trends?.disk?.at(-1),io=sample.at-point?.at<660000?point.devices?.[d.name]:null;
      return row(d.name,[d.device,d.model,problem(d)||(missing(d)?'Not present':d.smart_status&&'SMART '+d.smart_status),d.free_bytes>0&&tb(d.free_bytes)+' TB free',io&&'R '+speed(io.read)+' · W '+speed(io.write)].filter(Boolean).join(' · '),d.temperature_celsius>0?d.temperature_celsius+' °C':'—',problem(d)?'bad':'');
    };
    let result=[];
    if(docker)result=[...(items||[])].sort((a,b)=>Number(/unhealthy/i.test(b.status))-Number(/unhealthy/i.test(a.status))||(b.cpu_percent||0)-(a.cpu_percent||0)).map(containerRow);
    else if(page==='Disk health')result=(items||[]).filter(severity).sort(order).map(diskRow);
    else for(const label of groups){
      const list=(items||[]).filter(d=>group(d)===label).sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));
      if(list.length)result.push(make('h3',label+' · '+list.length,'group-label'),...list.map(diskRow));
    }
    rows.replaceChildren(...(result.length?result:[make('p',!items?'Waiting for readings':docker?'No running containers':page==='Disk inventory'?'No disks reported':'No disk alerts reported')]));
    rows.scrollTop=top;
  }
  function path(points,field,peak,gap){
    let d='',lastAt;
    for(const point of points){
      const x=300*(1-(sample.at-point.at)/300000),v=point[field];
      if(!Number.isFinite(v)||x<0){lastAt=null;continue;}
      d+=(lastAt && point.at-lastAt<=gap?'L':'M')+Math.min(300,x).toFixed(1)+' '+(58-55*Math.min(1,Math.max(0,v)/peak)).toFixed(1)+' ';
      lastAt=point.at;
    }
    return d;
  }
  function lines(points,keys,limit,gap){
    const peak=limit||Math.max(1,...points.flatMap(p=>keys.map(k=>p[k])).filter(Number.isFinite));
    for(const key of keys)$(key+'path').setAttribute('d',path(points,key,peak,gap));
  }
  const apps=['audiobookshelf','emby','mqtt','nextcloud','nginxproxymanager','nginx','postgresql','proxmox','radarr','redis','sonarr'];
  function icon(c){
    const slug=apps.find(a=>c.name.toLowerCase().replace(/[-_]/g,'').includes(a))||apps.find(a=>c.image?.toLowerCase().includes(a))||'docker';
    const img=document.createElement('img');img.alt='';img.className='appicon';img.title=c.name;
    const repo=c.image?.split('@')[0].replace(/:[^/:]+$/,'');
    const fallback='icons/'+(globalThis.unraidCatalogIcons[repo]||slug+'.svg');
    img.src=c.icon==='container-icons/'+c.name+'-icon.png'&&/^[a-z0-9_.-]+$/i.test(c.name)?c.icon:fallback;
    img.onerror=()=>{img.onerror=null;img.src=fallback;};return img;
  }
  function containerRow(c){
    const r=row(c.name,c.status||'running',pct(c.cpu_percent)+' CPU · '+fmt(c.memory_usage_bytes/2**20)+' MiB',/unhealthy/i.test(c.status)?'bad':'');
    r.classList.add('container-row');r.prepend(icon(c));
    const points=sample.trends?.docker?.[c.name]||[];
    for(const key of ['cpu','mem']){
      const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
      svg.setAttribute('viewBox','0 0 300 60');svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('role','img');svg.setAttribute('aria-label',key==='cpu'?'CPU trend':'RAM trend');
      const line=document.createElementNS(svg.namespaceURI,'path');
      line.setAttribute('d',path(points,key,Math.max(1,...points.map(p=>p[key]).filter(Number.isFinite)),45000));svg.append(line);r.append(svg);
    }
    return r;
  }
  function draw(force=false){
    const stale=sample && Date.now()-sample.at>30000;
    const key=[sample?.at,stale,page].join('/');
    if(!force&&key===last)return;last=key;
    const s=val('system')||{},a=val('array')||{},n=val('network')||{},disks=val('disks'),containers=val('docker')?.filter(c=>c.state==='running');
    const errors=Object.entries(sample?.sections||{}).filter(([,v])=>v.error);
    document.body.dataset.live=String(!!sample&&!stale&&!errors.length);
    txt('live',!sample?'Connecting':stale?'Last reading':errors.length?'Partial':'Live');
    txt('notice',errors.map(([name,v])=>name+' · '+v.error).join('   /   '));
    const name=window.Dashledge?.displayName(s.hostname)||s.hostname||'Unraid';txt('host',name);document.title=name+' · Unraid';txt('version','Unraid '+(s.version||''));txt('uptime',Number.isFinite(s.uptime_seconds)?fmt(Math.floor(s.uptime_seconds/86400))+'d uptime':'');
    if(page){inspect(disks,containers);return}
    txt('state',a.state||'Unknown');txt('free',tb(a.free_bytes));
    $('fill').style.width=Math.max(0,Math.min(100,a.used_percent||0))+'%';
    txt('capacity',pct(a.used_percent)+' used · '+tb(a.total_bytes)+' TB total');
    txt('parity',a.parity_check_status?[a.parity_check_status,Number.isFinite(a.parity_check_progress)?pct(a.parity_check_progress):''].filter(Boolean).join(' · '):a.parity_valid==null?'Parity unknown':a.parity_valid?'Parity valid':'Parity invalid');
    $('parity').classList.toggle('bad',a.parity_valid===false);
    const bays=(disks||[]).filter(d=>/^(disk\d+|parity\d*)$/i.test(d.name)).sort((a,b)=>Number(/^parity/.test(b.name))-Number(/^parity/.test(a.name))||a.name.localeCompare(b.name,undefined,{numeric:true}));
    const signature=JSON.stringify(bays.map(d=>[d.name,severity(d),d.spin_state]));
    if($('bays').dataset.key!==signature){$('bays').dataset.key=signature;$('bays').replaceChildren(...bays.map(d=>{
      const slot=d.name==='parity'?'P1':d.name==='parity2'?'P2':d.name.replace(/^disk/,'').padStart(2,'0');
      const b=make('i',slot,problem(d)?'fault':missing(d)?'absent':/^parity/.test(d.name)?'parity':/standby/i.test(d.spin_state)?'asleep':'');b.title=d.name;return b;
    }));}
    txt('baycount',fmt(a.num_data_disks)+' data · '+fmt(a.num_parity_disks)+' parity');
    const alerts=(disks||[]).filter(problem).sort(order),absent=(disks||[]).filter(missing);
    txt('health',!disks?'Awaiting disks':alerts.length?alerts.length+' disk '+(alerts.length===1?'alert':'alerts'):absent.length?'Check inventory':'No alerts');
    $('alerts-open').classList.toggle('alarm',!!alerts.length);
    const first=alerts[0];
    if(first)txt('health',first.name+' · '+problem(first));
    txt('issue',first?[group(first)==='Pool devices'?'Pool':group(first),first.device,first.model,first.temperature_celsius>0&&first.temperature_celsius+' °C',alerts.length>1&&'+'+(alerts.length-1)+' more'].filter(Boolean).join(' · '):!disks?'Waiting for inventory':alerts.length?alerts[0].name+' · '+problem(alerts[0]):absent.length?absent.map(d=>d.name).join(', ')+' · not present':'No reported disk issues');
    const sys=sample?.trends?.system||[],disk=sample?.trends?.disk||[],net=sample?.history||[];
    const io=disk.at(-1),fresh=io && sample.at-io.at<660000;
    txt('rx','↓ '+rate(n.rx_bytes_per_sec));txt('tx','↑ '+rate(n.tx_bytes_per_sec));
    txt('cpu',pct(s.cpu_usage_percent)+(s.cpu_temp_celsius>0?' · '+s.cpu_temp_celsius+'°':''));
    txt('memory',pct(s.ram_usage_percent));txt('read','R '+speed(fresh?io.read:null));txt('write','W '+speed(fresh?io.write:null));
    lines(sys,['cpu'],100,30000);lines(sys.map(p=>({at:p.at,memory:p.mem})),['memory'],100,30000);
    txt('poolRead','R '+speed(fresh?io.poolRead:null));txt('poolWrite','W '+speed(fresh?io.poolWrite:null));
    for(const pair of [['read','write'],['poolRead','poolWrite']]){
      const peak=Math.max(1,...disk.flatMap(p=>pair.map(k=>p[k])).filter(Number.isFinite));
      for(const field of pair){
        const line=disk.filter(p=>Number.isFinite(p[field]) && p.start<p.at).map(p=>{
          const x=t=>Math.max(0,Math.min(300,300*(1-(sample.at-t)/1800000))).toFixed(1);
          const y=(58-55*p[field]/peak).toFixed(1);
          return 'M'+x(p.start)+' '+y+'H'+x(p.at);
        }).join(' ');
        $(field+'path').setAttribute('d',line);
      }
    }
    lines(net,['rx','tx'],null,20000);
    txt('running',containers?containers.length+' running':'Awaiting containers');
    const busiest=[...(containers||[])].sort((a,b)=>(b.cpu_percent||0)-(a.cpu_percent||0));
    const signatureApps=JSON.stringify(busiest.map(c=>[c.name,c.icon,pct(c.cpu_percent),c.memory_usage_bytes]));
    if($('apps').dataset.key!==signatureApps){
      const scroll=$('apps').scrollTop;
      $('apps').dataset.key=signatureApps;
      $('apps').replaceChildren(...busiest.map(c=>{
        const line=make('span','','app-line');
        line.append(icon(c),make('span',c.name),make('b',pct(c.cpu_percent)),make('small',fmt(c.memory_usage_bytes/2**20)+' MiB'));return line;
      }));
      $('apps').scrollTop=scroll;
    }
    const sick=containers?.filter(c=>/unhealthy/i.test(c.status)).length;
    txt('hot',sick?sick+' unhealthy':busiest.length?'Highest CPU usage':'');$('docker-open').classList.toggle('alarm',!!sick);
  }
  window.serverSnapshot=s=>{if(s?.kind==='unraid'){sample=s;draw()}};
  // The connection's name, else the server's hostname, else the address's host.
  window.Dashledge?.subscribe(()=>{if(sample)draw()});
  function refresh(){if(document.hidden||loading)return;draw();loading=true;const script=document.createElement('script');const done=()=>{clearTimeout(timer);script.remove();loading=false};const timer=setTimeout(done,4500);script.onload=script.onerror=done;script.src='snapshot.js?t='+Date.now();document.head.append(script)}
  refresh();setInterval(refresh,5000);document.addEventListener('visibilitychange',refresh);
})();
