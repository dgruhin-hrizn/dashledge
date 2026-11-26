import {DatabaseSync} from 'node:sqlite';
import {accessSync, constants, existsSync, readFileSync, readdirSync, openSync, closeSync, readSync, statSync, fstatSync} from 'node:fs';
import {join, delimiter} from 'node:path';
import {homedir, tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {parse} from '../ember/shared.mjs';

const home = homedir();
const children = new Set();
process.on('exit', () => { for (const child of children) child.kill(); });

function executable(name, extras = []) {
  const dirs = [...(process.env.PATH || '').split(delimiter), join(home,'.local/bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const file of [...dirs.filter(Boolean).map(dir => join(dir,name)), ...extras]) {
    try { accessSync(file, constants.X_OK); return file; } catch {}
  }
}

// These processes receive control messages only. Never start a thread or send a model turn.
function probe(file, args, start, handle) {
  if (!file) return Promise.resolve(null);
  return new Promise(resolve => {
    const child = spawn(file,args,{cwd:tmpdir(),stdio:['pipe','pipe','ignore']});
    children.add(child);
    const lines = createInterface({input:child.stdout});
    const timeout = setTimeout(() => finish(null),15000);
    let settled=false;
    function finish(value) {
      if(settled)return;
      settled=true;
      clearTimeout(timeout); lines.close(); child.stdin.end(); child.kill(); resolve(value);
    }
    child.on('error',()=>finish(null));
    child.on('close',()=>{ children.delete(child); finish(null); });
    child.stdin.on('error',()=>finish(null));
    const send = msg => child.stdin.write(JSON.stringify(msg)+'\n');
    lines.on('line',line=>{
      try { handle(JSON.parse(line),send,finish); } catch { finish(null); }
    });
    start(send);
  });
}

function limit(label, used, reset) {
  if (!Number.isFinite(used)) return null;
  const time = typeof reset === 'number' ? reset*1000 : Date.parse(reset);
  return {label,used:Math.min(100,Math.max(0,used)),reset:Number.isFinite(time)?time:null};
}

export function emberAccounts(root = join(home,'Library/Application Support/Ember/User')) {
  const file=join(root,'globalStorage/ember.ember-agent/ember.db');
  if (!existsSync(file)) return [];
  const db=new DatabaseSync(file,{readOnly:true});
  try {
    let settings={};
    try { settings=parse(readFileSync(join(root,'settings.json'),'utf8')) || {}; } catch {}
    const configured=settings['ember.accounts.list'] || [];
    const accounts=configured.some(a=>a.id==='main') ? configured : [{id:'main',label:'Default'},...configured];
    const latest=db.prepare('SELECT value FROM kv WHERE key >= ? AND key < ? ORDER BY key DESC LIMIT 1');
    return accounts.flatMap(({id,label})=>{
      const prefix=id==='main'?'usage.limits.':'usage.accountLimits.'+id+'.';
      const row=latest.get(prefix,prefix.slice(0,-1)+'/');
      if (!row && id==='main' && !configured.length) return [];
      const raw=row && JSON.parse(row.value);
      const point=Array.isArray(raw)?raw.at(-1):raw;
      return [{id:'claude:'+id,provider:'Claude',name:label || id,source:'Ember',at:point?.ts,
        windows:(point?.windows || []).map(w=>limit(w.label||w.id,w.percent,w.resetsAt)).filter(Boolean)}];
    });
  } finally {db.close();}
}

export async function standaloneClaude() {
  const data=await probe(executable('claude'),['--print','--verbose','--input-format','stream-json','--output-format','stream-json','--no-session-persistence','--strict-mcp-config'],
    send=>send({type:'control_request',request_id:'limits',request:{subtype:'get_usage',skip_behaviors:true}}),
    (m,send,done)=>{if(m.type==='control_response' && m.response?.request_id==='limits') done(m.response.response);});
  const rl=data?.rate_limits;
  const pairs=[['5-hour',rl?.five_hour],['Weekly',rl?.seven_day],...(rl?.model_scoped||[]).map(w=>[w.display_name,w])];
  return {id:'claude:main',name:'Default',provider:'Claude',source:'Claude Code',at:Date.now(),
    windows:pairs.map(([label,w])=>limit(label,w?.utilization,w?.resets_at)).filter(Boolean)};
}

export function codexWindows(groups) {
  const windows=[];
  for(const [key,group] of Object.entries(groups||{})){
    for(const [slot,w] of [['Primary',group?.primary],['Secondary',group?.secondary]]){
      if(!w)continue;
      const minutes=w.windowDurationMins??w.window_minutes;
      const duration=minutes===10080?'Weekly':minutes===300?'5-hour':minutes>=1440&&minutes%1440===0?minutes/1440+'-day':minutes>=60&&minutes%60===0?minutes/60+'-hour':minutes?minutes+' min':slot;
      const label=key==='codex'?duration:(group.limitName||key)+' · '+duration;
      const value=limit(label,w.usedPercent??w.used_percent,w.resetsAt??w.resets_at);
      if(value)windows.push(value);
    }
  }
  return windows;
}

export async function liveCodex() {
  const binary=executable('codex',['/Applications/Codex.app/Contents/Resources/codex','/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex']);
  const result=await probe(binary,['app-server'],send=>send({id:1,method:'initialize',params:{clientInfo:{name:'dashledge',version:'1.0'},capabilities:null}}),
    (m,send,done)=>{
      if(m.id===1){
        if(m.error)return done(null);
        send({method:'initialized'});
        send({id:3,method:'account/read',params:{refreshToken:false}});
      }
      if(m.id===3){
        if(m.error)return done(null);
        if(m.result?.account?.type!=='chatgpt')return done({requiresSignIn:true});
        send({id:2,method:'account/rateLimits/read'});
      }
      if(m.id===2)done(m.result);
    });
  if(result?.requiresSignIn)return {id:'codex:local',provider:'Codex',name:'ChatGPT sign-in required',source:'Codex app server',windows:[]};
  const groups=result?.rateLimitsByLimitId;
  const windows=codexWindows(groups && Object.keys(groups).length?groups:{codex:result?.rateLimits});
  if(!windows.length)return null;
  return {id:'codex:local',provider:'Codex',name:result.rateLimits?.planType || 'Current account',source:'Codex app server',at:Date.now(),windows};
}

// Inspect only recent file tails for the provider's quota event. Never expose transcript data.
export function recentCodex(root=join(process.env.CODEX_HOME || join(home,'.codex'),'sessions'), now=new Date()) {
  let best;
  const candidates=[];
  for(let day=0;day<45;day++){
    const date=new Date(now);date.setUTCDate(date.getUTCDate()-day);
    const dir=join(root,...date.toISOString().slice(0,10).split('-'));
    try {
      for(const name of readdirSync(dir)){
        if(!name.startsWith('rollout-')||!name.endsWith('.jsonl'))continue;
        const file=join(dir,name);
        candidates.push({file,time:statSync(file).mtimeMs});
      }
    } catch {}
  }
  for(const {file,time} of candidates.sort((a,b)=>b.time-a.time).slice(0,12)){
      if(best && time<best.at)break;
      let fd;
      try{
        fd=openSync(file,'r');const size=fstatSync(fd).size;
        const buf=Buffer.alloc(Math.min(size,256*1024));
        const n=readSync(fd,buf,0,buf.length,size-buf.length);
        for(const line of buf.toString('utf8',0,n).trimEnd().split('\n').reverse()){
          if(!line.includes('"rate_limits"')||!line.includes('"token_count"'))continue;
          let event;try{event=JSON.parse(line);}catch{continue;}
          const r=event.payload?.rate_limits,at=Date.parse(event.timestamp);
          if(!r||!Number.isFinite(at))continue;
          const windows=codexWindows({[r.limit_id||'codex']:r});
          if(!windows.length)continue;
          if(!best||at>best.at)best={id:'codex:local',provider:'Codex',name:'Last local session',source:'Codex session snapshot',at,windows};
          break;
        }
      }catch{}finally{if(fd!==undefined)closeSync(fd);}
  }
  return best;
}
