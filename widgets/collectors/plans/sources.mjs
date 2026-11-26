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

const FIVE_HOURS = 300, WEEK = 10080;

function executable(name, extras = []) {
  const dirs = [...(process.env.PATH || '').split(delimiter), join(home,'.local/bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const file of [...dirs.filter(Boolean).map(dir => join(dir,name)), ...extras]) {
    try { accessSync(file, constants.X_OK); return file; } catch {}
  }
}

/** One allowance window. `minutes` is the window's length when the provider reports it, else null. */
function limit(label, used, reset, minutes = null) {
  if (!Number.isFinite(used)) return null;
  const time = typeof reset === 'number' ? reset*1000 : Date.parse(reset);
  return {label, used:Math.min(100,Math.max(0,used)), reset:Number.isFinite(time)?time:null,
    minutes:Number.isFinite(minutes) && minutes > 0 ? minutes : null};
}

/** Plan names as the providers market them. Unknown values are title-cased, never guessed. */
export function planName(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const key = value.trim().toLowerCase();
  const known = {max:'Max', pro:'Pro', plus:'Plus', team:'Team', enterprise:'Enterprise', business:'Business', edu:'Edu', free:'Free'};
  return known[key] || key.replace(/(^|[_\s-])(\w)/g, (_, sep, c) => (sep ? ' ' : '') + c.toUpperCase()).slice(0, 24);
}

function duration(minutes, slot) {
  if (minutes === WEEK) return 'Weekly';
  if (minutes === FIVE_HOURS) return '5-hour';
  if (minutes >= 1440 && minutes % 1440 === 0) return minutes/1440 + '-day';
  if (minutes >= 60 && minutes % 60 === 0) return minutes/60 + '-hour';
  return minutes ? minutes + ' min' : slot;
}

export function codexWindows(groups) {
  const windows=[];
  for(const [key,group] of Object.entries(groups||{})){
    for(const [slot,w] of [['Primary',group?.primary],['Secondary',group?.secondary]]){
      if(!w)continue;
      const minutes=w.windowDurationMins??w.window_minutes;
      const label=key==='codex'?duration(minutes,slot):(group.limitName||key)+' · '+duration(minutes,slot);
      const value=limit(label,w.usedPercent??w.used_percent,w.resetsAt??w.resets_at,minutes);
      if(value)windows.push(value);
    }
  }
  return windows;
}

/** Plan, limit-reached flag and banked reset credits from the Codex reader's output. */
export function codexDetails(result) {
  const groups = Object.values(result?.groups || {});
  const plan = planName(result?.planType ?? groups.find(g => g?.planType)?.planType);
  const reached = groups.some(g => g?.rateLimitReachedType);
  const resets = Number.isInteger(result?.resetCredits) && result.resetCredits > 0 ? result.resetCredits : 0;
  return {plan, reached, resets};
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

// Claude reports each band's group; only these lengths are known.
const bandMinutes = {session:FIVE_HOURS, weekly:WEEK};

export function claudeWindows(report) {
  const rates = report?.rate_limits;
  if (!rates || report.rate_limits_available === false) return [];
  const pairs = [['5-hour',rates.five_hour,FIVE_HOURS], ['Weekly',rates.seven_day,WEEK],
    ['OAuth apps weekly',rates.seven_day_oauth_apps,WEEK], ['Opus weekly',rates.seven_day_opus,WEEK],
    ['Sonnet weekly',rates.seven_day_sonnet,WEEK],
    // The older model-scoped list doesn't report a window length.
    ...(rates.model_scoped || []).map(w=>[w.display_name,w,null])];
  const windows = pairs.map(([name,w,minutes])=>limit(name,w?.utilization,w?.resets_at,minutes)).filter(Boolean);
  for (const band of Array.isArray(rates.limits) ? rates.limits : []) {
    const scoped = band?.scope?.model?.display_name || band?.scope?.surface?.display_name || band?.display_name;
    const minutes = bandMinutes[band?.group] ?? null;
    const label = ({session:'5-hour',weekly_all:'Weekly'})[band?.kind] ||
      (scoped && band?.group === 'weekly' ? scoped + ' weekly' : scoped);
    if (!label) continue;
    // The same model may already be listed without a length; the band supplies it.
    const known = windows.find(w=>w.label===label || (scoped && w.label===scoped));
    if (known) {
      if (!known.minutes && minutes) Object.assign(known, {label, minutes});
      continue;
    }
    const item = limit(label,band.percent,band.resets_at ?? band.reset_at,minutes);
    if (item) windows.push(item);
  }
  return windows;
}

function claudeEnv(profile) {
  const env = {...process.env, CLAUDE_CODE_SAFE_MODE:'1', DISABLE_AUTOUPDATER:'1'};
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_USE_)/.test(key)) delete env[key];
  }
  delete env.CLAUDE_CONFIG_DIR;
  env.USER ||= userInfo().username;
  env.LOGNAME ||= env.USER;
  if (profile.directory) env.CLAUDE_CONFIG_DIR = profile.directory;
  return env;
}

export async function readClaude(profile, query, binary) {
  const input = Promise.withResolvers();
  const prompt = {async *[Symbol.asyncIterator]() { await input.promise; }};
  const session = query({prompt, options:{pathToClaudeCodeExecutable:binary, cwd:tmpdir(), env:claudeEnv(profile),
    persistSession:false, settingSources:[], tools:[], strictMcpConfig:true, mcpServers:{}}});
  let timeout;
  try {
    const report = await Promise.race([
      session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors:true}),
      new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('timeout')),20000);})
    ]);
    return {windows:claudeWindows(report), plan:planName(report?.subscription_type)};
  } finally {
    clearTimeout(timeout);
    input.resolve();
    session.close();
  }
}

/**
 * How a Claude profile is signed in, from `claude auth status`. Only these fields are kept:
 * the command also prints the email and organization, which never belong in the snapshot.
 */
export function claudeSignIn(stdout) {
  let status;
  try { status = JSON.parse(stdout); } catch { return null; }
  if (typeof status?.loggedIn !== 'boolean') return null;
  return {loggedIn:status.loggedIn, method:typeof status.authMethod === 'string' ? status.authMethod : null,
    plan:planName(status.subscriptionType)};
}

async function claudeAuth(profile, binary) {
  try {
    const {stdout} = await run(binary, ['auth','status'], {env:claudeEnv(profile), cwd:tmpdir(), timeout:10000, maxBuffer:64*1024});
    return claudeSignIn(stdout);
  } catch (error) {
    // Claude Code may exit non-zero when signed out but still print the status.
    return typeof error?.stdout === 'string' ? claudeSignIn(error.stdout) : null;
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

/** The environment variable that selects a named profile, in the words a person types. */
function profileHint(profile) {
  if (!profile.directory || ['claude:main','codex:local'].includes(profile.id)) return '';
  const dir = profile.directory.startsWith(home + '/') ? '~' + profile.directory.slice(home.length) : profile.directory;
  return (profile.provider === 'Claude' ? 'CLAUDE_CONFIG_DIR=' : 'CODEX_HOME=') + dir + ' ';
}

/**
 * Account states the view tells apart:
 * - ok: windows were read.
 * - signedOut: no subscription sign-in for this profile.
 * - noPlan: signed in another way (API key or Console), which has no plan windows.
 * - empty: signed in to a subscription, but no windows were reported.
 * - missing: the provider's app isn't installed.
 * - limited: the provider is throttling usage checks.
 * - error: the read failed for another reason.
 */
export function classifyClaude(sdkError, auth) {
  if (auth?.loggedIn === false) return 'signedOut';
  if (auth?.loggedIn && auth.method && auth.method !== 'claude.ai') return 'noPlan';
  if (sdkError?.status === 429) return 'limited';
  if ([401,403].includes(sdkError?.status)) return 'signedOut';
  if (sdkError) return 'error';
  return auth?.loggedIn ? 'empty' : 'signedOut';
}

export function message(state, profile) {
  const claude = profile.provider === 'Claude', hint = profileHint(profile);
  switch (state) {
    case 'signedOut': return claude
      ? 'In Terminal, run ' + hint + 'claude and sign in with /login.'
      : 'In Terminal, run ' + hint + 'codex login with your ChatGPT account.';
    case 'noPlan': return 'Signed in with an API key or Console account. Plan limits apply only to subscriptions.';
    case 'empty': return 'Signed in, but no plan limits were reported.';
    case 'missing': return claude ? 'Install Claude Code on this Mac.' : 'Install Codex or the ChatGPT app on this Mac.';
    case 'limited': return (claude ? 'Claude' : 'OpenAI') + ' is limiting usage checks. Dashledge will retry.';
    default: return 'Could not reach ' + (claude ? 'Claude' : 'Codex') + '. Dashledge will retry.';
  }
}

async function claudeReading(profile, account) {
  const binary = executable('claude');
  if (!binary) return {...account, state:'missing'};
  const {query} = await import(pathToFileURL(join(sdkRoot,'claude/sdk.mjs')).href);
  let sdkError, reading = {windows:[], plan:null};
  try { reading = await readClaude(profile,query,binary); }
  catch (error) { sdkError = error; }
  let windows = reading.windows;
  if (!windows.length) {
    const fallback = await filePlan(profile, subscriptionClient).catch(() => null);
    if (fallback?.length) windows = fallback;
  }
  if (windows.length) return {...account, plan:reading.plan, windows, state:'ok'};
  // Only an empty read pays for a second process to learn why.
  const auth = await claudeAuth(profile, binary);
  return {...account, plan:auth?.plan ?? reading.plan, state:classifyClaude(sdkError, auth)};
}

async function codexReading(profile, account) {
  const binary = executable('codex',['/Applications/Codex.app/Contents/Resources/codex','/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex']);
  if (!binary) return {...account, state:'missing'};
  const env = {...process.env};
  delete env.OPENAI_API_KEY;
  delete env.CODEX_HOME;
  if (profile.directory) env.CODEX_HOME = profile.directory;
  const {stdout} = await run(join(sdkRoot,'python/bin/python3'),['-I','-B',fileURLToPath(new URL('./codex-sdk.py',import.meta.url)),binary],
    {env,cwd:tmpdir(),timeout:20000,maxBuffer:128*1024});
  const result = JSON.parse(stdout);
  if (result.signedOut) return {...account, state:'signedOut'};
  const {plan, reached, resets} = codexDetails(result);
  const windows = codexWindows(result.groups);
  return {...account, plan, windows, reached, resets, state:windows.length ? 'ok' : 'empty'};
}

export async function readProfile(profile) {
  const {id, provider, name} = profile;
  const account = {id,provider,name,plan:null,windows:[]};
  let next;
  try {
    next = provider === 'Claude' ? await claudeReading(profile, account) : await codexReading(profile, account);
  } catch (error) {
    next = {...account, state:error?.status === 429 ? 'limited' : 'error'};
  }
  if (next.state === 'ok') return {...next, at:Date.now()};
  return {...next, message:message(next.state, profile)};
}

/**
 * Combine a fresh read with the previous one. A transient failure keeps the last windows and marks
 * them stale with the reason, so the view can say how old they are. A sign-in problem never does.
 */
export function merge(last, next) {
  if (next.state === 'ok' || !last?.at || !['limited','error'].includes(next.state)) return next;
  return {...last, stale:true, state:next.state, message:next.message};
}

/** Seconds until an account is read again. Accounts that need a person to act are checked less often. */
export function nextCheck(account, failures = 0) {
  if (account.state === 'ok') return 60;
  if (['signedOut','noPlan','missing','empty'].includes(account.state)) return 300;
  return Math.min(900, 60 * 2 ** Math.min(failures, 4));
}
