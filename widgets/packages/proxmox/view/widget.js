(() => {
  const el = id => document.getElementById(id);
  const text = (tag,value) => Object.assign(document.createElement(tag),{textContent:value});
  const pct = n => n == null ? "—" : Math.round(100*n)+"%";
  const gib = n => n == null ? "—" : (n/2**30).toLocaleString(undefined,{maximumFractionDigits:1})+" GiB";
  const fill = n => Math.max(0,Math.min(100,(n ?? 0)*100))+"%";
  let snapshot, page=0, pending=false;
  function signal() {
    const live = !!snapshot?.data && !snapshot.issue && (snapshot.demo || Date.now()-snapshot.sampleAt < 20000);
    document.body.dataset.live = String(live);
    el("signal").textContent = snapshot?.demo ? "Demo" : live ? "Live" : snapshot?.data ? "Stale" : "Waiting";
    el("stamp").textContent = snapshot?.demo ? "Sample data" : snapshot?.sampleAt ? new Date(snapshot.sampleAt).toLocaleTimeString() : "Awaiting collector";
    el("notice").textContent = snapshot?.issue || (live ? "" : snapshot?.data ? "Collector delayed · showing last reading" : "Waiting for the first cluster snapshot.");
    el("notice").hidden = !el("notice").textContent;
  }
  const gauges = new Map();
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const sweepMs = 850;
  let frame = 0;
  function position(g,now) {
    const t = Math.max(0,Math.min(1,(now-g.start)/sweepMs));
    const eased = t*t*(3-2*t);
    return t === 1 ? g.target : g.from+(g.target-g.from)*eased;
  }
  function paint(g) {
    const label = g.value == null ? "—" : Math.round(g.value)+"%";
    for (const node of g.nodes) {
      const readout = node.firstElementChild;
      if (readout.textContent !== label) readout.textContent = label;
      node.dataset.wide = String(label.length >= 4);
      node.style.setProperty("--value",fill(g.value == null ? null : g.value/100));
    }
  }
  function animate(now) {
    frame = 0;
    let moving = false;
    for (const g of gauges.values()) {
      if (g.value === g.target) continue;
      g.value = motion.matches ? g.target : position(g,now);
      paint(g);
      moving ||= g.value !== g.target;
    }
    if (moving) frame = requestAnimationFrame(animate);
  }
  function bindGauge(node,key,target) {
    const now = performance.now();
    let g = gauges.get(key);
    if (!g) {
      g = {value:target,from:target,target,start:now,nodes:[]};
      gauges.set(key,g);
    } else if (target !== g.target) {
      g.value = target == null || g.target == null || motion.matches ? target : position(g,now);
      g.from = g.value;
      g.target = target;
      g.start = now;
    }
    g.nodes.push(node);
    if (!node.firstElementChild) node.replaceChildren(text("em",""));
    paint(g);
    if (!frame && g.value !== g.target) frame = requestAnimationFrame(animate);
  }
  function nodeCard(n) {
    const card=document.createElement("article"); card.className="node"; card.dataset.online=n.online;
    const header=document.createElement("header");
    header.append(text("h3",n.name),text("small",n.online?"Online":"Offline")); card.append(header);
    card.dataset.busy = String(n.online && n.cpu > 0 && n.vms > 0);
    const cpu=n.online?n.cpu:null, ram=n.online && n.capacity && n.used!=null ? n.used/n.capacity : null;
    for(const [label,value,detail] of [["CPU",cpu,n.online && n.cores ? pct(cpu)+" · "+n.cores+" cores" : pct(cpu)],["Memory",ram,ram==null?"—":gib(n.used)+" / "+gib(n.capacity)+" · "+pct(ram)]]) {
      const row=document.createElement("div"); row.className="node-line";
      row.append(text("span",label),text("b",detail));
      const track=document.createElement("div"); track.className=label==="Memory"?"bar mem":"bar";
      const bar=document.createElement("i"); bar.style.width=fill(value);track.append(bar);card.append(row,track);
    }
    const footer=document.createElement("footer");
    const hours=Math.floor((n.uptime??0)/3600);
    footer.append(text("span",n.online?n.vms+" running VMs":"VM count unavailable"),text("span",n.online && n.uptime!=null?"Up "+(hours>=24?Math.floor(hours/24)+"d":hours+"h"):"—"));
    card.append(footer);return card;
  }
  function gpuGauge(key,load) {
    const gauge = text("b","");
    gauge.className = "ring gpu-gauge";
    gauge.dataset.key = key;
    gauge.dataset.load = load ?? "";
    return gauge;
  }
  function renderGPUDials(vms) {
    const panel = document.querySelector(".dials");
    for (const item of panel.querySelectorAll(".guest-dial")) item.remove();
    for (const vm of vms) {
      if (!vm.gpu) continue;
      const devices = vm.gpu.devices ?? [];
      for (const [i,gpu] of (devices.length ? devices : [null]).entries()) {
        const item = document.createElement("div");
        item.className = "guest-dial";
        const sameNode = vms.some(other => other.id !== vm.id && other.node === vm.node && other.gpu);
        const label = vm.node+(sameNode ? " · "+vm.id : "")+" GPU"+(devices.length>1 ? " "+(i+1) : "");
        item.title = vm.name+" · VM "+vm.id+" · "+(gpu?.name ?? vm.gpu.status);
        item.append(gpuGauge(vm.id+"/"+(gpu?.uuid ?? "offline"),gpu?.load),text("span",label));
        panel.append(item);
      }
    }
  }
  const vmRows = new Map();
  function renderVMs(data) {
    const list = el("vm-list");
    const guests = data?.runningVMs ?? [];
    const active = new Set(guests.map(vm => vm.id));
    for (const [id,row] of vmRows) {
      if (!active.has(id)) { row.remove(); vmRows.delete(id); }
    }
    if (!guests.length) {
      const message = !data ? "Awaiting inventory" : !data.runningVMs ? "Awaiting updated collector" : "No running VMs visible";
      if (list.textContent !== message) list.replaceChildren(text("p",message));
      return;
    }
    list.querySelector(":scope > p")?.remove();
    guests.forEach((vm,index) => {
      let row = vmRows.get(vm.id);
      if (!row) {
        row = el("vm-card").content.firstElementChild.cloneNode(true);
        vmRows.set(vm.id,row);
      }
      row.dataset.busy = String(vm.cpu > 0);
      row.querySelector("h3").textContent = vm.name;
      row.querySelector(".vm-identity small").textContent = vm.node+" · VM "+vm.id;
      const ram = vm.used != null && vm.capacity > 0 ? vm.used/vm.capacity : null;
      for (const [selector,usage,detail] of [
        [".processor",vm.cpu,vm.cores == null ? "vCPU count unavailable" : vm.cores+" vCPU"],
        [".memory",ram,gib(vm.used)+" / "+gib(vm.capacity)]
      ]) {
        const reading = row.querySelector(selector);
        reading.querySelector("strong").textContent = pct(usage);
        reading.querySelector("small").textContent = detail;
        reading.style.setProperty("--fill",fill(usage));
      }
      let gpuSection = row.querySelector(".gpu-readings");
      if (vm.gpu) {
        if (!gpuSection) {
          gpuSection = document.createElement("section");
          gpuSection.className = "gpu-readings";
          row.append(gpuSection);
        }
        const signature = vm.gpu.status+" "+vm.gpu.at;
        if (gpuSection.dataset.sample !== signature) {
          gpuSection.dataset.sample = signature;
          gpuSection.replaceChildren();
          if (!vm.gpu.devices?.length) {
            const device = document.createElement("div");
            device.className = "guest-device";
            device.append(gpuGauge(vm.id+"/offline",null),text("h4",vm.gpu.status));
            gpuSection.append(device);
          }
          for (const gpu of vm.gpu.devices ?? []) {
            const device=document.createElement("div");
            device.className="guest-device";
            const gauge=gpuGauge(vm.id+"/"+gpu.uuid,gpu.load);
            gauge.setAttribute("aria-label","GPU utilization "+(gpu.load == null ? "unavailable" : gpu.load+"%"));
            device.append(gauge,text("h4",gpu.name));
            gpuSection.append(device);
            const plot = document.createElementNS("http://www.w3.org/2000/svg","svg");
            plot.setAttribute("viewBox","0 0 240 32"); plot.setAttribute("preserveAspectRatio","none");
            plot.setAttribute("aria-label","GPU utilization over one minute"); plot.setAttribute("role","img");
            let path="",last=0;
            for (const p of gpu.points) {
              if (p.load == null) {last=0;continue;}
              const x=240*(1-(vm.gpu.at-p.at)/60000), y=31-.3*Math.min(100,p.load);
              path+=(last && p.at-last<10000?"L":"M")+x.toFixed(1)+" "+y.toFixed(1)+"h0.1 ";
              last=p.at;
            }
            const line=document.createElementNS(plot.namespaceURI,"path");
            line.setAttribute("d",path);plot.append(line);device.append(plot);
            const memory = n => n == null ? "—" : (n/1024).toLocaleString(undefined,{maximumFractionDigits:2})+" GiB";
            device.append(text("small","VRAM "+memory(gpu.used)+" / "+memory(gpu.total)));
            const meter=text("i","");meter.className="vm-meter";
            meter.style.setProperty("--fill",fill(gpu.used != null && gpu.total>0 ? gpu.used/gpu.total : null));
            device.append(meter,text("small",[gpu.temp!=null && gpu.temp+" °C",gpu.watts!=null && gpu.watts+" W"].filter(Boolean).join(" · ")));
          }
        }
      } else gpuSection?.remove();
      if (list.children[index] !== row) list.insertBefore(row,list.children[index] ?? null);
    });
  }
  function render(){
    signal();
    const data=snapshot?.data;
    const name=window.Dashledge?.displayName(data?.name)||data?.name||"Cluster overview";
    el("cluster").textContent=name;document.title=name+" · Proxmox";
    el("vm").textContent=data?.running??"—";
    el("guests").textContent=data?data.total+" VMs total · "+data.containers+" LXC running":"Awaiting inventory";
    for (const g of gauges.values()) g.nodes = [];
    bindGauge(el("cpu"),"cpu",data?.cpu == null ? null : data.cpu*100);
    bindGauge(el("ram"),"ram",data?.capacity ? 100*data.used/data.capacity : null);
    el("online").textContent=data?data.online+" / "+data.nodes.length+" online":"—";
    el("quorum").textContent=data?.quorum==null?"":data.quorum?"Quorum healthy":"Quorum lost";
    el("quorum").dataset.lost=String(data?.quorum===false);
    for(const metric of ["cpu","ram"]){
      let path="",previous=0,area="",firstX,lastX;
      function closeArea(){if(firstX!=null) area+="L"+lastX+" 88 L"+firstX+" 88 Z ";firstX=null;}
      for(const point of snapshot?.history??[]){
        const v=point[metric];if(v==null){previous=0;closeArea();continue;}
        const x=500*(1-(snapshot.at-point.at)/600000),y=87-86*Math.max(0,Math.min(1,v));
        const connected=previous && point.at-previous<16000;
        if(!connected){closeArea();firstX=x.toFixed(1);}
        lastX=x.toFixed(1);
        const segment=(connected?"L":"M")+lastX+" "+y.toFixed(1)+" ";
        path+=segment;area+=segment;previous=point.at;
      }
      if(metric==="cpu"){closeArea();el("area").setAttribute("d",area);}
      el(metric+"-line").setAttribute("d",path);
    }
    renderGPUDials(data?.runningVMs ?? []);
    renderVMs(data);
    for (const node of document.querySelectorAll(".gpu-gauge")) {
      bindGauge(node,node.dataset.key,node.dataset.load === "" ? null : Number(node.dataset.load));
    }
    for (const [key,g] of gauges) if (!g.nodes.length) gauges.delete(key);
    const nodes=data?.nodes??[];
    // Node cards are 275 reference px wide; --px-scale sizes them for a native view.
    const scale=Number(getComputedStyle(document.documentElement).getPropertyValue("--px-scale"))||1;
    const perPage=Math.max(1,Math.min(4,Math.floor(el("nodes").clientWidth/(275*scale))));
    const pages=Math.max(1,Math.ceil(nodes.length/perPage));
    page=Math.min(page,pages-1);
    el("nodes").style.setProperty("--count",Math.max(1,Math.min(nodes.length,perPage)));
    el("nodes").replaceChildren(...nodes.slice(page*perPage,(page+1)*perPage).map(nodeCard));
    document.querySelector(".paging").hidden=pages===1;
    el("prev").disabled=page===0;el("next").disabled=page===pages-1;
    el("page").textContent=(page+1)+" / "+pages;
  }
  el("prev").onclick=()=>{page=Math.max(0,page-1);render();};
  el("next").onclick=()=>{page++;render();};
  window.proxmoxSample = sample => {if(snapshot?.at!==sample.at){snapshot=sample;render();}};
  function poll(){
    signal(); if(pending)return; pending=true;
    const s=document.createElement("script");
    const finish=()=>{clearTimeout(timer);s.remove();pending=false;};
    const timer=setTimeout(finish,3500);
    s.onload=s.onerror=finish;s.src="snapshot.js?t="+Date.now();document.head.append(s);
  }
  window.addEventListener("resize",render);render();
  window.Dashledge?.subscribe(({theme}) => {
    // Dashledge's highlight (General, or this placement's own) is the CPU colour; its text colour is the ink.
    if (theme?.accent && CSS.supports("color", theme.accent)) document.documentElement.style.setProperty("--cpu",theme.accent);
    if (theme?.primary && CSS.supports("color", theme.primary)) document.documentElement.style.setProperty("--ink",theme.primary);
    render();
  });
  if (window.proxmoxDemo) window.proxmoxSample(window.proxmoxDemo);
  else {poll();setInterval(poll,2500);}
})();
