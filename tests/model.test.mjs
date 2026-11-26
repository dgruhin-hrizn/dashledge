import test from 'node:test';
import assert from 'node:assert/strict';
import {initial,makePage,resize,plugin,readPath,count,presets} from '../ui/model.js';
test('each preset places the advertised number of independent instances',()=>{
  for(const preset of Object.keys(presets)){
    const page=makePage('Test',preset);
    assert.equal(page.slots.length,count(preset));
    assert.equal(new Set(page.slots.map(s=>s.id)).size,page.slots.length);
  }
});
test('page nine and beyond survive a settings round trip',()=>{
  const config=initial();
  for(let n=config.pages.length;n<32;n++) config.pages.push(makePage('Page '+(n+1),'One',['cpu']));
  const restored=JSON.parse(JSON.stringify(config));
  assert.equal(restored.pages[8].name,'Page 9');
  assert.equal(restored.pages.length,32);
});
test('smaller layouts retain configured instances and reject destructive changes',()=>{
  const page=makePage('Performance','Five',['empty','disk','network']);
  page.slots[1].volume='/Volumes/Example';const disk=page.slots[1].id;
  resize(page,'Two');assert.equal(page.slots[0].id,disk);assert.equal(page.slots[0].volume,'/Volumes/Example');
  const snapshot=structuredClone(page);assert.throws(()=>resize(page,'One'));assert.deepEqual(page,snapshot);
});
test('widget packages validate their data feed and can read nested JSON arrays',()=>{
  const sample={apiVersion:1,id:'plugin.example',title:'Free memory',feed:'json',field:'rows.0.free',unit:' GB',accent:'#abc123'};
  assert.equal(readPath({rows:[{free:12}]},plugin(sample).field),12);
  for(const field of ['constructor.name','__proto__.x','a..b'])assert.throws(()=>plugin({...sample,field}));
  assert.throws(()=>plugin({...sample,feed:'shell'}));
});
test('splits preserve existing tile identity and divide exactly the selected region',async()=>{
  const {split,regions}=await import('../ui/model.js');
  const page=makePage('Studio','Featured',['cpu','gpu','memory']), original=page.slots[0].id;
  split(page,0,'row');split(page,1,'column');
  assert.equal(page.slots.length,5);assert.equal(page.slots[0].id,original);
  assert.equal(regions(page).reduce((sum,r)=>sum+r.w*r.h,0).toFixed(4),'1.0000');
  resize(page,'Five');assert.equal(page.regions,undefined);
});

test('connection import keeps existing identities and binds separate worker slots',async()=>{
  const {mergeSources}=await import('../ui/migration.js');
  const cfg=initial(),p=makePage('Workers','Two',['comfy','comfy']);
  cfg.pages=[p];
  cfg.sources=[{id:'custom',name:'Saved name',kind:'comfy',address:'http://one.example/'}];
  const rows=[{kind:'comfy',name:'Original name',address:'http://one.example'},{kind:'comfy',name:'Worker two',address:'http://two.example/'}];
  assert.equal(mergeSources(cfg,rows),1);assert.equal(cfg.sources[0].name,'Saved name');
  assert.deepEqual(p.slots.map(s=>s.source),cfg.sources.map(s=>s.id));
  assert.equal(mergeSources(cfg,rows),0);
});
test('Add page activates a new numbered canvas without requiring a keyboard',async()=>{
  const {appendPage}=await import('../ui/page-actions.js');const cfg=initial();
  cfg.pages[0].name='Page 5';
  const added=appendPage(cfg);
  assert.equal(added.name,'Page 6');assert.equal(added.slots[0].kind,'empty');
});
