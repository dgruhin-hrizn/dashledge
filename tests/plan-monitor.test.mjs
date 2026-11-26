import assert from 'node:assert/strict';
import test from 'node:test';
import {chmodSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {classifyClaude,claudeSignIn,codexDetails,filePlan,merge,message,nextCheck,planName,profiles,codexWindows,readClaude,claudeWindows} from '../widgets/packages/plans/collector/sources.mjs';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// The view's model is a classic script (views load it with <script>); run it the same way.
vm.runInThisContext(readFileSync(new URL('../widgets/packages/plans/view/plan-model.js',import.meta.url),'utf8'));
const {accountOptions,accountStatus,badges,pace,paceText,primaryWindow,visibleAccounts,windowCaption,windowState}=globalThis.planModel;

test('Codex uses reported windows and preserves a genuine zero',()=>{
  assert.deepEqual(codexWindows({codex:{primary:{usedPercent:0,windowDurationMins:10080,resetsAt:123}},extra:{limitName:'Extra',primary:{usedPercent:67,windowDurationMins:300},secondary:{usedPercent:null}}}),[
    {label:'Weekly',used:0,reset:123000,minutes:10080},{label:'Extra · 5-hour',used:67,reset:null,minutes:300}
  ]);
});
test('Codex details carry the plan, a reached limit and banked resets only',()=>{
  assert.deepEqual(codexDetails({planType:'pro',resetCredits:4,groups:{codex:{planType:'pro'},review:{rateLimitReachedType:'secondary'}}}),{plan:'Pro',reached:true,resets:4});
  assert.deepEqual(codexDetails({groups:{codex:{planType:'plus'}}}),{plan:'Plus',reached:false,resets:0});
  assert.deepEqual(codexDetails({resetCredits:-1}),{plan:null,reached:false,resets:0});
});
test('plan names are the marketed ones and never invented',()=>{
  assert.equal(planName('max'),'Max');
  assert.equal(planName('enterprise_plus'),'Enterprise Plus');
  assert.equal(planName(''),null);
  assert.equal(planName(null),null);
});
test('standalone profile discovery includes defaults and configured named profiles',t=>{
  const root=mkdtempSync(join(tmpdir(),'plan-profiles-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  for(const [dir,file] of [['.claude-work','settings.json'],['.codex-personal','config.toml'],['.claude-backup','unrelated']]){
    mkdirSync(join(root,dir));writeFileSync(join(root,dir,file),'');
  }
  assert.deepEqual(profiles(root).map(a=>a.id),['claude:main','codex:local','claude:work','codex:personal']);
});
test('Claude uses only the SDK quota control and closes its empty input',async()=>{
  let prompt,closed=false;
  const report={subscription_type:'max',rate_limits_available:true,rate_limits:{five_hour:{utilization:0},seven_day:{utilization:72,resets_at:120},model_scoped:[{display_name:'Opus',utilization:11}]}};
  const {windows,plan}=await readClaude({directory:'/profile'},args=>{
    prompt=args.prompt;
    assert.equal(args.options.env.CLAUDE_CONFIG_DIR,'/profile');
    assert.equal(args.options.persistSession,false);
    return {async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(opts){assert.deepEqual(opts,{skipBehaviors:true});return report;},close(){closed=true;}};
  },'/cli');
  assert.ok(closed);
  assert.equal((await prompt[Symbol.asyncIterator]().next()).done,true);
  assert.equal(plan,'Max');
  assert.deepEqual(windows.map(w=>[w.used,w.minutes]),[[0,300],[72,10080],[11,null]]);
  assert.equal(windows[1].reset,120000);
  assert.deepEqual(claudeWindows({rate_limits_available:false,rate_limits:report.rate_limits}),[]);
});
test('Claude bands supply a scoped window’s length without duplicating it',()=>{
  const windows=claudeWindows({rate_limits:{
    model_scoped:[{display_name:'Fable',utilization:3}],
    limits:[{kind:'weekly_scoped',group:'weekly',percent:3,scope:{model:{display_name:'Fable'}}},
      {kind:'weekly_scoped',group:'weekly',percent:40,resets_at:'2026-11-29T07:00:00Z',scope:{model:{display_name:'Opus'}}},
      {kind:'mystery',percent:9,display_name:'Mystery'}]}});
  assert.deepEqual(windows.map(w=>[w.label,w.minutes]),[['Fable weekly',10080],['Opus weekly',10080],['Mystery',null]]);
});

test('file-backed Claude login uses only its own profile and handles new quota bands',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'plan-login-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const file=join(directory,'.credentials.json');
  writeFileSync(file,JSON.stringify({claudeAiOauth:{accessToken:'test-profile',expiresAt:Date.now()+60000}}),{mode:0o600});
  const client=async token=>{
    assert.equal(token,'test-profile');
    return {get:async path=>{
      assert.equal(path,'/api/oauth/usage');
      return {limits:[{kind:'session',percent:0,resets_at:100},{kind:'weekly_all',percent:94},
        {kind:'model',scope:{model:{display_name:'Sonnet'}},percent:8}]};
    }};
  };
  assert.deepEqual((await filePlan({directory},client)).map(w=>[w.label,w.used]),[['5-hour',0],['Weekly',94],['Sonnet',8]]);
  chmodSync(file,0o644);
  assert.equal(await filePlan({directory},client),null);
});

test('Claude sign-in status keeps no identity and tells the states apart',()=>{
  const out=JSON.stringify({loggedIn:true,authMethod:'claude.ai',subscriptionType:'max',email:'someone@example.com',orgId:'org'});
  assert.deepEqual(claudeSignIn(out),{loggedIn:true,method:'claude.ai',plan:'Max'});
  assert.equal(claudeSignIn('not json'),null);
  assert.equal(classifyClaude(null,{loggedIn:false}),'signedOut');
  assert.equal(classifyClaude(null,{loggedIn:true,method:'console'}),'noPlan');
  assert.equal(classifyClaude(null,{loggedIn:true,method:'claude.ai'}),'empty');
  assert.equal(classifyClaude({status:429},null),'limited');
  assert.equal(classifyClaude({status:401},null),'signedOut');
  assert.equal(classifyClaude(Error('timeout'),{loggedIn:true,method:'claude.ai'}),'error');
  assert.equal(classifyClaude(null,null),'signedOut');
});
test('guidance names the profile to sign in to and never mentions a button',()=>{
  const home=process.env.HOME;
  assert.match(message('signedOut',{id:'claude:work',provider:'Claude',directory:home+'/.claude-work'}),/CLAUDE_CONFIG_DIR=~\/\.claude-work claude/);
  assert.match(message('signedOut',{id:'codex:local',provider:'Codex'}),/run codex login/);
  for(const state of ['signedOut','noPlan','empty','missing','limited','error'])
    assert.doesNotMatch(message(state,{id:'claude:main',provider:'Claude'}),/tap|Refresh/i);
});
test('a failed refresh keeps the last reading as stale; a sign-in problem does not',()=>{
  const last={id:'a',state:'ok',at:1000,windows:[{label:'Weekly',used:10}]};
  assert.deepEqual(merge(last,{id:'a',state:'error',windows:[],message:'down'}),{...last,stale:true,state:'error',message:'down'});
  assert.equal(merge(last,{id:'a',state:'signedOut',windows:[]}).state,'signedOut');
  assert.equal(merge(undefined,{id:'a',state:'limited',windows:[]}).state,'limited');
  assert.equal(merge({...last,stale:true},{id:'a',state:'ok',at:2000,windows:[]}).stale,undefined);
});
test('accounts that need a person are checked less often and failures back off',()=>{
  assert.equal(nextCheck({state:'ok'}),60);
  assert.equal(nextCheck({state:'signedOut'}),300);
  assert.deepEqual([0,1,2,3,9].map(n=>nextCheck({state:'error'},n)),[60,120,240,480,900]);
});

const H=3600000,now=Date.UTC(2026,10,26,12);
test('a window past its reset reads as full, and an unstarted one says so',()=>{
  assert.deepEqual(windowState({used:80,reset:now-1},now),{left:100,expired:true,idle:false,level:'ok'});
  assert.equal(windowState({used:0,reset:null},now).idle,true);
  assert.equal(windowCaption({used:0,reset:null},now),'Starts with your next request');
  assert.equal(windowCaption({used:80,reset:now-1},now),'Reset · updating');
  assert.equal(windowCaption({used:5,reset:now+26*H},now),'Resets in 1d 2h');
  assert.deepEqual(['ok','low','critical','out'].map((_,i)=>windowState({used:[50,80,95,100][i],reset:null},now).level),['ok','low','critical','out']);
  assert.equal(windowState({used:NaN},now),null);
});
test('the dial follows the tightest window',()=>{
  const weekly={label:'Weekly',used:60,reset:now+48*H},session={label:'5-hour',used:60,reset:now+2*H},opus={label:'Opus',used:10,reset:now+H};
  assert.equal(primaryWindow([weekly,session,opus],now),session);
  assert.equal(primaryWindow([{label:'old',used:99,reset:now-1},opus],now),opus);
  assert.equal(primaryWindow([],now),null);
});
test('pace projects only reported windows, after a tenth has passed',()=>{
  const week=10080,reset=now+3.5*24*H;              // half of the week has passed
  assert.deepEqual(pace({used:20,minutes:week,reset},now),{projected:40,elapsed:.5,outAt:null});
  const hot=pace({used:80,minutes:week,reset},now);   // 160% by reset: runs out in 7/8 day
  assert.equal(hot.projected,160);
  assert.equal(Math.round((hot.outAt-now)/H),21);
  assert.equal(paceText(hot,reset,now),'At this pace, runs out in 21h 0m');
  assert.equal(paceText(pace({used:20,minutes:week,reset},now),reset,now),'On pace for 40% used by reset');
  assert.equal(pace({used:20,minutes:null,reset},now),null);
  assert.equal(pace({used:5,minutes:300,reset:now+290*60000},now),null);
  assert.equal(pace({used:0,minutes:week,reset},now),null);
});
test('account status distinguishes checking, readings, stale and needed action',()=>{
  const ok={state:'ok',at:now-2*60000,windows:[{label:'Weekly',used:10,reset:now+H}]};
  assert.deepEqual(accountStatus(ok,now,{loaded:false}),{reading:false,tone:'calm',title:'Checking…',detail:'Reading accounts on this Mac'});
  assert.deepEqual(accountStatus(ok,now),{reading:true,tone:'calm',title:'Updated 2m ago',detail:''});
  assert.deepEqual(accountStatus({...ok,stale:true,state:'limited',message:'Slow down'},now),{reading:true,tone:'warn',title:'Last reading 2m ago',detail:'Slow down'});
  assert.equal(accountStatus({...ok,at:now-40*60000},now).title,'Last reading 40m ago');
  assert.equal(accountStatus(ok,now,{offline:true}).tone,'warn');
  assert.deepEqual(accountStatus({state:'signedOut',windows:[],message:'Run claude'},now),{reading:false,tone:'alert',title:'Not signed in',detail:'Run claude'});
  assert.equal(accountStatus({state:'error',windows:[],message:'x'},now).tone,'warn');
  assert.equal(accountStatus({state:'checking',windows:[]},now).title,'Checking…');
  assert.equal(accountStatus({windows:[]},now,{offline:true}).title,'Monitor stopped');
});
test('placements show their chosen accounts or their pinned one',()=>{
  const all=[{id:'a'},{id:'b'},{id:'c'}];
  assert.deepEqual(visibleAccounts(all,{}).map(a=>a.id),['a','b','c']);
  assert.deepEqual(visibleAccounts(all,{accounts:['*']}).map(a=>a.id),['a','b','c']);
  assert.deepEqual(visibleAccounts(all,{accounts:['c','a']}).map(a=>a.id),['a','c']);
  assert.deepEqual(visibleAccounts(all,{accounts:['b']}).map(a=>a.id),['b']);
  assert.deepEqual(visibleAccounts(all,{accounts:['gone']}),[]);
  assert.deepEqual(visibleAccounts(all,{accounts:[]}),[]);
});
test('badges call out a reached limit and banked resets',()=>{
  assert.deepEqual(badges({reached:true,resets:1}),[{tone:'alert',text:'Limit reached'},{tone:'calm',text:'1 reset banked'}]);
  assert.deepEqual(badges({resets:4}),[{tone:'calm',text:'4 resets banked'}]);
  assert.deepEqual(badges({}),[]);
});
test('accounts are offered to settings with the status the tile shows',()=>{
  const now=Date.UTC(2026,0,1);
  const options=accountOptions([
    {id:'claude:main',provider:'Claude',name:'Default',plan:'Max',at:now,windows:[{label:'5-hour',used:40,reset:now+3600000,minutes:300}]},
    {id:'codex:local',provider:'Codex',name:'Current account',state:'signedOut',windows:[]},
  ],now,{loaded:true});
  assert.deepEqual(options[0],{value:'claude:main',label:'Claude Max · Default',detail:'60% left · 5-hour · Updated just now'});
  assert.equal(options[1].label,'Codex · Current account');
  assert.match(options[1].detail,/^Not signed in/);
});
