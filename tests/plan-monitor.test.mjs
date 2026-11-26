import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {emberAccounts,codexWindows,recentCodex} from '../widgets/collectors/plans/sources.mjs';

test('Codex uses reported windows and preserves a genuine zero',()=>{
  assert.deepEqual(codexWindows({codex:{primary:{usedPercent:0,windowDurationMins:10080,resetsAt:123}},extra:{limitName:'Extra',primary:{usedPercent:67,windowDurationMins:300},secondary:{usedPercent:null}}}),[
    {label:'Weekly',used:0,reset:123000},{label:'Extra · 5-hour',used:67,reset:null}
  ]);
});
test('a resumed older Codex session retains the timestamp of its quota observation',t=>{
  const root=mkdtempSync(join(tmpdir(),'dash-plan-log-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const folder=join(root,'2026','11','07');mkdirSync(folder,{recursive:true});
  const timestamp='2026-11-26T01:00:00Z';
  writeFileSync(join(folder,'rollout-old.jsonl'),JSON.stringify({timestamp,payload:{type:'token_count',rate_limits:{primary:{used_percent:12,window_minutes:300}}}})+'\n');
  assert.equal(recentCodex(root,new Date(timestamp)).at,Date.parse(timestamp));
});
test('Ember reads the latest limit separately for each named account, including legacy arrays',t=>{
  const root=mkdtempSync(join(tmpdir(),'dash-plan-ember-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const folder=join(root,'globalStorage','ember.ember-agent');mkdirSync(folder,{recursive:true});
  writeFileSync(join(root,'settings.json'),'{"ember.accounts.list":[{"id":"other","label":"Work"}],}');
  const db=new DatabaseSync(join(folder,'ember.db'));
  db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT)');
  const add=db.prepare('INSERT INTO kv VALUES(?,?)');
  const point=p=>({ts:23,windows:[{label:'Weekly',percent:p,resetsAt:'2026-12-01T00:00:00Z'}]});
  add.run('usage.limits.01',JSON.stringify(point(2)));
  add.run('usage.limits.02',JSON.stringify([point(57)]));
  add.run('usage.accountLimits.other.01',JSON.stringify(point(17)));db.close();
  assert.deepEqual(emberAccounts(root).map(a=>[a.name,a.windows[0].used]),[['Default',57],['Work',17]]);
});
