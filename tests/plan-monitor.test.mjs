import assert from 'node:assert/strict';
import test from 'node:test';
import {chmodSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {filePlan,profiles,codexWindows,readClaude,claudeWindows} from '../widgets/collectors/plans/sources.mjs';

test('Codex uses reported windows and preserves a genuine zero',()=>{
  assert.deepEqual(codexWindows({codex:{primary:{usedPercent:0,windowDurationMins:10080,resetsAt:123}},extra:{limitName:'Extra',primary:{usedPercent:67,windowDurationMins:300},secondary:{usedPercent:null}}}),[
    {label:'Weekly',used:0,reset:123000},{label:'Extra · 5-hour',used:67,reset:null}
  ]);
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
  const report={rate_limits_available:true,rate_limits:{five_hour:{utilization:0},seven_day:{utilization:72,resets_at:120},model_scoped:[{display_name:'Opus',utilization:11}]}};
  const windows=await readClaude({directory:'/profile'},args=>{
    prompt=args.prompt;
    assert.equal(args.options.env.CLAUDE_CONFIG_DIR,'/profile');
    assert.equal(args.options.persistSession,false);
    return {async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(opts){assert.deepEqual(opts,{skipBehaviors:true});return report;},close(){closed=true;}};
  },'/cli');
  assert.ok(closed);
  assert.equal((await prompt[Symbol.asyncIterator]().next()).done,true);
  assert.deepEqual(windows.map(w=>w.used),[0,72,11]);
  assert.equal(windows[1].reset,120000);
  assert.deepEqual(claudeWindows({rate_limits_available:false,rate_limits:report.rate_limits}),[]);
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
