import {accessSync, constants, existsSync, readdirSync} from 'node:fs';
import {dirname, join, delimiter} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {homedir, tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const home = homedir();
const sdkRoot = join(dirname(process.execPath), 'plan-sdks');
const run = promisify(execFile);

function executable(name, extras = []) {
  const dirs = [...(process.env.PATH || '').split(delimiter), join(home,'.local/bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const file of [...dirs.filter(Boolean).map(dir => join(dir,name)), ...extras]) {
    try { accessSync(file, constants.X_OK); return file; } catch {}
  }
}

function limit(label, used, reset) {
  if (!Number.isFinite(used)) return null;
  const time = typeof reset === 'number' ? reset*1000 : Date.parse(reset);
  return {label,used:Math.min(100,Math.max(0,used)),reset:Number.isFinite(time)?time:null};
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

export function profiles(root = home) {
  const accounts = [
    {id:'claude:main', provider:'Claude', name:'Default', directory:process.env.CLAUDE_CONFIG_DIR},
    {id:'codex:local', provider:'Codex', name:'Current account', directory:process.env.CODEX_HOME}
  ];
  let entries;
  try { entries = readdirSync(root, {withFileTypes:true}); } catch { return accounts; }
  for (const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
    const match = /^\.(claude|codex)-([a-z0-9][a-z0-9_-]*)$/i.exec(entry.name);
    if (!entry.isDirectory() || !match) continue;
    const [, kind, name] = match;
    const directory = join(root, entry.name);
    const marker = kind === 'claude' ? 'settings.json' : 'config.toml';
    if (!existsSync(join(directory, marker)) || accounts.some(a=>a.directory===directory || a.id===kind+':'+name)) continue;
    accounts.push({id:kind+':'+name, provider:kind==='claude'?'Claude':'Codex', name, directory});
  }
  return accounts;
}

export function claudeWindows(report) {
  const rates = report?.rate_limits;
  if (!rates || report.rate_limits_available === false) return [];
  const pairs = [['5-hour',rates.five_hour], ['Weekly',rates.seven_day],
    ['OAuth apps weekly',rates.seven_day_oauth_apps], ['Opus weekly',rates.seven_day_opus], ['Sonnet weekly',rates.seven_day_sonnet],
    ...(rates.model_scoped || []).map(w=>[w.display_name,w])];
  return pairs.map(([name,w])=>limit(name,w?.utilization,w?.resets_at)).filter(Boolean);
}

export async function readClaude(profile, query, binary) {
  const env = {...process.env, CLAUDE_CODE_SAFE_MODE:'1', DISABLE_AUTOUPDATER:'1'};
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_USE_)/.test(key)) delete env[key];
  }
  if (profile.directory) env.CLAUDE_CONFIG_DIR = profile.directory;
  const input = Promise.withResolvers();
  const prompt = {async *[Symbol.asyncIterator]() { await input.promise; }};
  const session = query({prompt, options:{pathToClaudeCodeExecutable:binary, cwd:tmpdir(), env,
    persistSession:false, settingSources:[], tools:[], strictMcpConfig:true, mcpServers:{}}});
  let timeout;
  try {
    const report = await Promise.race([
      session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors:true}),
      new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('timeout')),20000);})
    ]);
    return claudeWindows(report);
  } finally {
    clearTimeout(timeout);
    input.resolve();
    session.close();
  }
}

export async function readProfile(profile) {
  const {id, provider, name} = profile;
  const source = provider==='Claude'?'Claude Agent SDK':'OpenAI Codex SDK';
  const account = {id,provider,name,source,windows:[]};
  try {
    if (provider==='Claude') {
      const binary = executable('claude');
      if (!binary) return {...account,message:'Install Claude Code and sign in with your Claude subscription.'};
      const {query} = await import(pathToFileURL(join(sdkRoot,'claude/sdk.mjs')).href);
      account.windows = await readClaude(profile,query,binary);
    } else {
      const binary = executable('codex',['/Applications/Codex.app/Contents/Resources/codex','/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex']);
      if (!binary) return {...account,message:'Install Codex and sign in with your ChatGPT account.'};
      const env = {...process.env};
      delete env.OPENAI_API_KEY;
      if (profile.directory) env.CODEX_HOME = profile.directory;
      const {stdout} = await run(join(sdkRoot,'python/bin/python3'),['-I','-B',fileURLToPath(new URL('./codex-sdk.py',import.meta.url)),binary],
        {env,cwd:tmpdir(),timeout:20000,maxBuffer:128*1024});
      const result = JSON.parse(stdout);
      if (result.signedOut) return {...account,message:'Sign in to Codex with your ChatGPT account.'};
      account.windows = codexWindows(result.groups);
    }
    if (account.windows.length) return {...account,at:Date.now()};
    return {...account,message:'No plan limits reported. Check your subscription sign-in and refresh.'};
  } catch {
    return {...account,unavailable:true,message:'Could not refresh. Check your connection and update '+(provider==='Claude'?'Claude Code':'Codex')+', then retry.'};
  }
}
