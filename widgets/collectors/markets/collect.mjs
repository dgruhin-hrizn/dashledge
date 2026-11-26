import {writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {context} from '../context.mjs';
import {symbols} from './symbols.mjs';

const {key,secret}=context.sources[0];
const tickers=Object.keys(symbols);
const series=Object.fromEntries(tickers.map(t=>[t,{name:symbols[t],points:[]}]));
const headers={'APCA-API-KEY-ID':key,'APCA-API-SECRET-KEY':secret};
const file=join(context.directory,'market.json');
let status='Connecting',dirty=true,writing=false,attempt=0;
const nyDate=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
function trade(s,time,price){
  if(!Number.isFinite(time)||!Number.isFinite(price)||price<=0||time<(s.time||0))return;
  const minute=Math.floor(time/60000)*60000;
  if(s.time && nyDate.format(time)!==nyDate.format(s.time))s.points=[];
  const last=s.points.at(-1);
  if(last?.[0]===minute)last[1]=price;
  else s.points.push([minute,price]);
  s.price=price;s.time=time;dirty=true;
}
async function flush(){
  if(writing||!dirty)return;
  dirty=false;writing=true;
  try{await writeFile(file+'.tmp',JSON.stringify({status,series}));await rename(file+'.tmp',file)}
  catch{dirty=true}finally{writing=false}
}
async function get(path){
  const response=await fetch('https://data.alpaca.markets/v2/stocks/'+path,{headers,signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error(String(response.status));
  return response.json();
}
async function seed(){
  try{
    const snap=await get('snapshots?feed=iex&symbols='+tickers.join(','));
    await Promise.all(tickers.map(async ticker=>{
      const s=series[ticker],v=snap[ticker];if(!v)return;
      const time=Date.parse(v.latestTrade?.t);if(!Number.isFinite(time))return;
      s.close=v.prevDailyBar?.c;trade(s,time,v.latestTrade.p);dirty=true;
      const start=new Date(time-24*3600000).toISOString();
      try{
        const data=await get(ticker+'/bars?feed=iex&timeframe=1Min&limit=1440&start='+encodeURIComponent(start));
        const points=new Map((data.bars||[]).map(b=>[Date.parse(b.t),b.c]).filter(([t])=>nyDate.format(t)===nyDate.format(s.time)));
        for(const [t,p] of s.points)points.set(t,p);
        s.points=[...points].sort((a,b)=>a[0]-b[0]);dirty=true;
      }catch{/* Live trades continue to build the chart. */}
    }));
  }catch{/* The socket reports connection and authentication status separately. */}
}
function connect(){
  const ws=new WebSocket('wss://stream.data.alpaca.markets/v2/iex');
  const timeout=setTimeout(()=>ws.close(),15000);
  ws.onopen=()=>ws.send(JSON.stringify({action:'auth',key,secret}));
  ws.onmessage=event=>{
    let messages;try{messages=JSON.parse(event.data)}catch{return}
    for(const m of messages){
      if(m.T==='success'&&m.msg==='authenticated')ws.send(JSON.stringify({action:'subscribe',trades:tickers}));
      if(m.T==='subscription'){clearTimeout(timeout);status='Connected';attempt=0;dirty=true;seed()}
      if(m.T==='t'&&series[m.S])trade(series[m.S],Date.parse(m.t),m.p);
      if(m.T==='error'){status='Alpaca · '+m.msg;dirty=true;ws.close()}
    }
  };
  ws.onerror=()=>ws.close();
  ws.onclose=()=>{clearTimeout(timeout);if(!status.startsWith('Alpaca ·'))status='Reconnecting';dirty=true;setTimeout(connect,Math.min(60000,2000*2**Math.min(attempt++,5)))};
}
setInterval(flush,200);setInterval(seed,15*60000);flush();connect();
