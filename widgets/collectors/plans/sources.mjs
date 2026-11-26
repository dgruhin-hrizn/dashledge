import {accessSync, constants, existsSync, readdirSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {dirname, join, delimiter} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {homedir, tmpdir, userInfo} from 'node:os';
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
  const windows = pairs.map(([name,w])=>limit(name,w?.utilization,w?.resets_at)).filter(Boolean);
  for (const band of Array.isArray(rates.limits) ? rates.limits : []) {
    const label = ({session:'5-hour',weekly_all:'Weekly'})[band?.kind] ||
      band?.scope?.model?.display_name || band?.scope?.surface?.display_name || band?.display_name;
    if (!label || windows.some(w=>w.label===label)) continue;
    const item = limit(label,band.percent,band.resets_at ?? band.reset_at);
    if (item) windows.push(item);
  }
  return windows;
}

export async function readClaude(profile, query, binary) {
  const env = {...process.env, CLAUDE_CODE_SAFE_MODE:'1', DISABLE_AUTOUPDATER:'1'};
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_USE_)/.test(key)) delete env[key];
  }
  env.USER ||= userInfo().username;
  env.LOGNAME ||= env.USER;
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

// Claude Code can store a subscription sign-in in a private file when Keychain is unavailable.
export async function filePlan(profile, createClient) {
  const directory = profile.directory || join(home,'.claude');
  let file;
  let login;
  try {
    file = await open(join(directory,'.credentials.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 65536) return null;
    login = JSON.parse(await file.readFile('utf8')).claudeAiOauth;
  } catch { return null; }
  finally { await file?.close(); }
  if (!login?.accessToken || !Number.isFinite(login.expiresAt) || login.expiresAt <= Date.now()) return null;
  const client = await createClient(login.accessToken);
  const rates = await client.get('/api/oauth/usage', {headers:{'anthropic-beta':'oauth-2025-04-20'}});
  return claudeWindows({rate_limits:rates});
}

async function subscriptionClient(authToken) {
  const path = join(sdkRoot,'anthropic/node_modules/@anthropic-ai/sdk/index.mjs');
  const {default:Anthropic} = await import(pathToFileURL(path).href);
  return new Anthropic({authToken, apiKey:null, baseURL:'https://api.anthropic.com',
    logLevel:'off', maxRetries:0, timeout:8000, fetchOptions:{redirect:'error'}});
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
      let sdkError;
      try { account.windows = await readClaude(profile,query,binary); }
      catch (error) { sdkError = error; }
      if (!account.windows.length) {
        const fallback = await filePlan(profile, subscriptionClient);
        if (fallback?.length) {
          account.windows = fallback;
          account.source = 'Anthropic SDK';
        } else if (sdkError) throw sdkError;
        else return {...account,message:'Open Claude Code with this profile, run /login, then tap Refresh.'};
      }
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
  } catch (error) {
    if (provider==='Claude' && [401,403].includes(error.status))
      return {...account,message:'Claude needs a renewed subscription sign-in. Run /login in this profile, then refresh.'};
    if (error.status===429)
      return {...account,unavailable:true,message:'The provider is limiting usage checks. Try again shortly.'};
    return {...account,unavailable:true,message:'Could not refresh. Check your connection and update '+(provider==='Claude'?'Claude Code':'Codex')+', then retry.'};
  }
}
