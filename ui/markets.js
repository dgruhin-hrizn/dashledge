import {button,el,field,invoke,select} from './common.js';

import {marketLogo,showMarketLogo} from './market-logo.js';
import {editWatchlist,watchlist} from './market-watchlist.js';
const money=new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const stamp=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit'});
export const marketPicker=(slot,save)=>select(watchlist(slot).map(t=>[t,t]),slot.marketSymbol||watchlist(slot)[0],save);

export function marketConnection(){
  const wrap=el('div','fields'),key=el('input'),secret=el('input'),message=el('p','sub');
  for(const input of [key,secret]){input.type='password';input.autocomplete='off';input.spellcheck=false}
  async function submit(disconnect){
    connect.disabled=remove.disabled=true;
    try{
      if(!disconnect&&(!key.value.trim()||!secret.value.trim()))throw Error('Enter the key ID and secret.');
      await invoke('markets_connect',{key:disconnect?'':key.value,secret:disconnect?'':secret.value});
      key.value=secret.value='';message.textContent=disconnect?'Disconnected.':'Connected to Alpaca IEX.';
      localStorage.setItem('edge.market.connection',String(Date.now()));
    }catch(e){message.textContent=String(e)}finally{connect.disabled=remove.disabled=false}
  }
  const connect=button('Test and connect',()=>submit(false)),remove=button('Disconnect',()=>submit(true));
  message.setAttribute('role','status');
  wrap.append(el('p','sub','Use credentials from your Alpaca paper or live account. All Market Watch placements share this connection.'),
    field('API key ID',key),field('API secret',secret),connect,remove,message);
  return wrap;
}

function plot(canvas,points,color,fill,extendedStart){
  const rect=canvas.getBoundingClientRect(),w=rect.width,h=rect.height;
  if(!w||!h)return;
  const scale=window.devicePixelRatio||1;
  if(canvas.width!==Math.round(w*scale)||canvas.height!==Math.round(h*scale)){
    canvas.width=Math.round(w*scale);canvas.height=Math.round(h*scale);
  }
  const ctx=canvas.getContext('2d');if(!ctx)return;
  ctx.setTransform(scale,0,0,scale,0,0);ctx.clearRect(0,0,w,h);
  if(fill){
    ctx.strokeStyle='#ffffff12';ctx.lineWidth=1;
    for(let i=1;i<=3;i++){const y=h*i/4;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke()}
  }
  if(!points?.length)return;
  const prices=points.map(p=>p[1]),lo=Math.min(...prices),hi=Math.max(...prices),pad=fill?10:3;
  const start=points[0][0],duration=Math.max(1,points.at(-1)[0]-start);
  const x=t=>pad+(w-2*pad)*(t-start)/duration;
  const y=p=>hi===lo?h/2:h-pad-(h-2*pad)*(p-lo)/(hi-lo);
  if(fill && Number.isFinite(extendedStart)){
    const boundary=x(extendedStart);ctx.fillStyle='#eab76416';ctx.fillRect(boundary,0,w-boundary,h);
    ctx.strokeStyle='#eab76488';ctx.setLineDash([3,5]);ctx.beginPath();ctx.moveTo(boundary,0);ctx.lineTo(boundary,h);ctx.stroke();ctx.setLineDash([]);
  }
  ctx.beginPath();points.forEach(([t,p],i)=>i?ctx.lineTo(x(t),y(p)):ctx.moveTo(x(t),y(p)));
  ctx.strokeStyle=color;ctx.lineWidth=fill?2.6:1.5;ctx.lineJoin='round';ctx.stroke();
  const [t,p]=points.at(-1);
  if(fill){
    const gradient=ctx.createLinearGradient(0,0,0,h);gradient.addColorStop(0,color+'45');gradient.addColorStop(1,color+'00');
    ctx.lineTo(x(t),h);ctx.lineTo(x(start),h);ctx.closePath();ctx.fillStyle=gradient;ctx.fill();
    ctx.beginPath();ctx.arc(x(t),y(p),4,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();
  }
}

export function mountMarkets(box,slot,save){
  const tickers=watchlist(slot);
  let selected=tickers.includes(slot.marketSymbol)?slot.marketSymbol:tickers[0],feed,disposed=false,visible=true,running=false,series={},connection='',last='',nextPing=0,nextOpen=0;
  const viewer=crypto.randomUUID();box.classList.add('market-watch');
  const main=el('section','mw-main'),head=el('header'),name=el('strong'),ticker=el('span','mw-ticker');
  const hero=el('div','mw-hero'),price=el('strong','mw-price','—'),change=el('span','mw-change');
  const chart=el('canvas','mw-chart'),meta=el('footer'),time=el('span'),state=el('span');
  const rail=el('aside','mw-rail'),rows=el('div','mw-rows'),controls=el('div','mw-controls');
  const choose=s=>save({marketSymbol:s,marketSymbols:tickers});
  const picker=marketPicker(slot,choose);picker.setAttribute('aria-label','Featured symbol');
  const setup=button('Connect Alpaca',()=>{localStorage.setItem('edge.market.setup','1');invoke('open_settings').catch(e=>state.textContent=String(e))});
  setup.hidden=true;
  const logoSurfaces=new Map();
  const heroMark=marketLogo(selected),session=el('span','mw-session');
  head.append(heroMark,ticker,name);hero.append(price,change,session);meta.append(el('b','','IEX'),time,state,setup);main.append(head,hero,chart,meta);
  controls.append(el('h2','','Market Watch'),button('Edit list',()=>editWatchlist(slot,save,true)),picker);rail.append(controls,rows);box.append(main,rail);
  const buttons=tickers.map(sym=>{
    const b=button('',()=>choose(sym)),spark=el('canvas'),quote=el('span');
    b.setAttribute('aria-label','Show '+sym);const mark=marketLogo(sym);b.append(mark,el('b','',sym),spark,quote);rows.append(b);return {b,mark,spark,quote,sym};
  });
  const color=d=>d<0?'#ffa692':'#7ee8c2';
  function draw(){
    const data=series[selected]||{}, delta=data.price-data.close;
    ticker.textContent=selected;name.textContent=data.name||'';
    price.textContent=Number.isFinite(data.price)?'$'+money.format(data.price):'—';
    change.textContent=Number.isFinite(delta)&&data.close>0?(delta>=0?'+':'−')+money.format(Math.abs(delta))+'  ('+(delta>=0?'+':'−')+(Math.abs(delta)/data.close*100).toFixed(2)+'%)':'';
    showMarketLogo(heroMark,selected,feed,data.logo,logoSurfaces);
    const after=data.session==='After hours',pre=data.session==='Pre-market';
    const baseline=after?data.regularClose:data.close;
    const ext=data.price-baseline;
    session.hidden=!(after||pre);
    session.textContent=session.hidden?'':data.session+(Number.isFinite(ext)&&baseline>0?'  '+(ext>=0?'+':'−')+money.format(Math.abs(ext))+' ('+(ext>=0?'+':'−')+(Math.abs(ext)/baseline*100).toFixed(2)+'%)':'');
    change.title='Change from previous session close';
    change.style.color=color(delta);plot(chart,data.points,color(delta),true,data.extendedStart);
    chart.setAttribute('aria-label',selected+' intraday IEX price chart');
    time.textContent=data.time?'Last trade · '+stamp.format(data.time)+' ET':'Awaiting trade data';
    state.textContent=connection;
    chart.parentElement.dataset.direction=delta<0?'down':'up';
    for(const {sym,b,mark,spark,quote} of buttons){
      const item=series[sym]||{};showMarketLogo(mark,sym,feed,item.logo,logoSurfaces);b.setAttribute('aria-pressed',String(sym===selected));
      quote.textContent=Number.isFinite(item.price)?money.format(item.price):'—';
      plot(spark,item.points,color(item.price-item.close),false);
    }
  }
  function release(id){if(id)invoke('widget_close',{id,viewer}).catch(()=>{})}
  async function update(){
    if(running||disposed||!visible||document.hidden||box.closest('[hidden]'))return;
    running=true;
    try{
      if(!feed){
        if(Date.now()<nextOpen)return;
        nextOpen=Date.now()+10000;
        const id=await invoke('widget_open',{kind:'markets',sources:[],viewer});
        if(disposed){release(id);return}
        try{await invoke('markets_watch',{id,viewer,symbols:tickers})}catch(e){release(id);throw e}
        if(disposed){release(id);return}
        feed=id;last='';setup.hidden=true;
      }
      if(Date.now()>=nextPing){
        nextPing=Date.now()+10000;
        if(!await invoke('widget_ping',{id:feed,viewer})){release(feed);feed=null;throw Error('Reconnecting')}
      }
      const response=await fetch('/widget-view/'+encodeURIComponent(feed)+'/market.json',{cache:'no-store'});
      if(!response.ok)throw Error('Waiting for market stream…');
      const raw=await response.text();
      if(disposed||raw===last)return;
      const snapshot=JSON.parse(raw);last=raw;series=snapshot.series;connection=snapshot.status+' · USD';draw();
    }catch(e){if(!disposed){last='';connection=String(e);setup.hidden=!/Alpaca|Keychain|credential/i.test(connection);draw()}}
    finally{running=false}
  }
  function reconnect(e){if(e.key==='edge.market.connection'){release(feed);feed=null;nextOpen=0;update()}}
  const observer=new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;if(visible){draw();update()}});observer.observe(box);
  const resize=new ResizeObserver(draw);resize.observe(box);
  window.addEventListener('storage',reconnect);draw();update();const timer=setInterval(update,500);
  return ()=>{disposed=true;clearInterval(timer);observer.disconnect();resize.disconnect();release(feed);window.removeEventListener('storage',reconnect)};
}
