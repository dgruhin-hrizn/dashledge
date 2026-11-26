import {mkdir,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {context,onWatchlist} from '../context.mjs';
import {symbols} from './symbols.mjs';
import {sessionAt,tradingDate,applyTrade} from './session.mjs';

const {key,secret}=context.sources[0];
const headers={'APCA-API-KEY-ID':key,'APCA-API-SECRET-KEY':secret};
const trading=key.startsWith('PK')?'https://paper-api.alpaca.markets':'https://api.alpaca.markets';
const data='https://data.alpaca.markets';
const file=join(context.directory,'market.json');
const series=Object.create(null),calendar=new Map();
let ws,authenticated=false,active=[],wanted=[],attempt=0,status='Connecting',dirty=true,writing=false,retry;
async function request(url){
  const r=await fetch(url,{headers,signal:AbortSignal.timeout(12000)});
  if(!r.ok)throw Error(String(r.status));
  return r;
}
async function refreshCalendar(){
  const now=Date.now(),start=tradingDate(now-14*86400000),end=tradingDate(now+7*86400000);
  try{
    const dates=await (await request(trading+'/v2/calendar?start='+start+'&end='+end)).json();
    for(const d of dates)calendar.set(d.date,{open:d.open.slice(0,5),close:d.close.slice(0,5)});
  }catch{/* Keep session unlabeled until a verified exchange calendar is available. */}
}
let calendarReady=refreshCalendar();
setInterval(()=>{calendarReady=refreshCalendar()},6*3600000);
async function metadata(t,s){
  try{const asset=await (await request(trading+'/v2/assets/'+t)).json();s.name=asset.name||s.name}catch{}
  try{
    const response=await request(data+'/v1beta1/logos/'+t+'?placeholder=false');
    const bytes=Buffer.from(await response.arrayBuffer());
    if(bytes.length>2e6||!bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))return;
    const dir=join(context.directory,'logos');await mkdir(dir,{recursive:true});await writeFile(join(dir,t+'.png'),bytes);
    s.logo=true;
  }catch{/* A company monogram remains visible when logos are unavailable. */}
  finally{dirty=true}
}
async function seed(tickers){
  if(!tickers.length)return;
  try{
    await calendarReady;
    const snapshots=await (await request(data+'/v2/stocks/snapshots?feed=iex&symbols='+tickers.join(','))).json();
    await Promise.all(tickers.map(async t=>{
      const s=series[t],v=snapshots[t];if(!s||!v)return;
      const ts=Date.parse(v.latestTrade?.t),bar=v.latestMinuteBar||v.minuteBar;
      const barTime=Date.parse(bar?.t);
      if(Number.isFinite(ts))applyTrade(s,ts,v.latestTrade.p,calendar);
      if(Number.isFinite(barTime)&&(!s.time||barTime>s.time))applyTrade(s,barTime,bar.c,calendar);
      if(!s.time)return;
      const date=tradingDate(s.time);
      // Daily bars are timestamped at session midnight. Before the open the latest
      // daily bar can still belong to the previous trading day.
      const dailyTime=Date.parse(v.dailyBar?.t);
      s.close=Number.isFinite(dailyTime)&&tradingDate(dailyTime)<date?v.dailyBar.c:v.prevDailyBar?.c;
      s.session=sessionAt(s.time,calendar);dirty=true;
      const start=new Date(s.time-86400000).toISOString();
      try{
        const result=await (await request(data+'/v2/stocks/'+t+'/bars?feed=iex&timeframe=1Min&limit=1440&start='+encodeURIComponent(start))).json();
        if(tradingDate(s.time)!==date)return;
        const points=new Map((result.bars||[]).map(b=>[Date.parse(b.t),b.c]).filter(([time])=>tradingDate(time)===date));
        for(const [time,price] of s.points)points.set(time,price);
        s.points=[...points].sort((a,b)=>a[0]-b[0]);
        s.extendedStart=s.points.find(([time])=>sessionAt(time,calendar)==='After hours')?.[0];
        s.regularClose=s.points.findLast(([time])=>sessionAt(time,calendar)==='Regular session')?.[1];
        dirty=true;
      }catch{}
    }));
  }catch{}
}
function sync(){
  if(!authenticated)return;
  const remove=active.filter(t=>!wanted.includes(t)),add=wanted.filter(t=>!active.includes(t));
  if(remove.length)ws.send(JSON.stringify({action:'unsubscribe',trades:remove}));
  if(add.length)ws.send(JSON.stringify({action:'subscribe',trades:add}));
  active=[...wanted];
}
onWatchlist(list=>{
  const added=list.filter(t=>!series[t]);
  for(const t of added){series[t]={name:symbols[t]||t,points:[]};metadata(t,series[t])}
  for(const t of wanted)if(!list.includes(t))delete series[t];
  wanted=list;dirty=true;sync();seed(added);
});
function connect(){
  ws=new WebSocket('wss://stream.data.alpaca.markets/v2/iex');
  const timeout=setTimeout(()=>ws.close(),15000);
  ws.onopen=()=>ws.send(JSON.stringify({action:'auth',key,secret}));
  ws.onmessage=event=>{
    let messages;try{messages=JSON.parse(event.data)}catch{return}
    for(const m of messages){
      if(m.T==='success'&&m.msg==='authenticated'){
        clearTimeout(timeout);authenticated=true;status='Connected';dirty=true;attempt=0;sync();
      }
      if(m.T==='t'&&series[m.S]){applyTrade(series[m.S],Date.parse(m.t),m.p,calendar);dirty=true}
      if(m.T==='error'){status='Alpaca · '+m.msg;dirty=true;ws.close()}
    }
  };
  ws.onerror=()=>ws.close();
  ws.onclose=()=>{clearTimeout(timeout);authenticated=false;active=[];if(!status.startsWith('Alpaca ·'))status='Reconnecting';dirty=true;clearTimeout(retry);retry=setTimeout(connect,Math.min(60000,2000*2**Math.min(attempt++,5)))};
}
async function flush(){
  if(writing||!dirty)return;
  dirty=false;writing=true;
  try{await writeFile(file+'.tmp',JSON.stringify({status,series}));await rename(file+'.tmp',file)}
  catch{dirty=true}finally{writing=false}
}
setInterval(flush,200);setInterval(()=>seed(wanted),15*60000);flush();connect();
