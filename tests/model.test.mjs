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

test('Add page activates a new numbered canvas without requiring a keyboard',async()=>{
  const {appendPage}=await import('../ui/page-actions.js');const cfg=initial();
  cfg.pages[0].name='Page 5';
  const added=appendPage(cfg);
  assert.equal(added.name,'Page 6');assert.equal(added.slots[0].kind,'empty');
});

test('clearing a widget then collapsing a nested split retains neighboring slots and restores the parent bounds',async()=>{
  const {regions,split,removeSection}=await import('../ui/model.js');
  const {assignWidget}=await import('../ui/page-actions.js');
  const config=initial(),page=config.pages[0],original=regions(page);
  split(page,1,'column');split(page,2,'row');
  page.slots[2]=assignWidget(config,'memory',page.slots[2]);
  assert.throws(()=>removeSection(page,2));
  page.slots[2]=assignWidget(config,'empty',page.slots[2]);removeSection(page,2);
  removeSection(page,2);
  assert.deepEqual(page.slots.map(s=>s.kind),['cpu','gpu','memory','disk','network']);
  assert.deepEqual(regions(page).map(r=>[r.x,r.y,r.w,r.h].map(v=>v.toFixed(6))),original.map(r=>[r.x,r.y,r.w,r.h].map(v=>v.toFixed(6))));
  const legacy=makePage('Old','Featured',['cpu','empty','gpu']);legacy.regions=regions(legacy);
  removeSection(legacy,1);
  assert.equal(regions(legacy)[1].h,1);assert.equal(legacy.slots[1].kind,'gpu');
  assert.throws(()=>removeSection(makePage('Last','One'),0));
});

test('removing an installed widget clears its placements, retains credentials and filters the available widgets',async()=>{
  const {installed,placements,removeWidget,connectionsFor,useDefault,defaultSource}=await import('../ui/widget-catalog.js');
  const config=initial(),page=config.pages[0];
  config.sources=[{id:'one',kind:'omlx'},{id:'two',kind:'omlx'},{id:'endpoint',kind:'json',owner:'plugin.custom'}];
  page.slots[0].kind=page.slots[1].kind='omlx';page.slots[1].source='two';
  useDefault(config,'omlx','one');assert.equal(page.slots[0].source,'one');assert.equal(page.slots[1].source,'two');
  assert.equal(defaultSource(config,'omlx'),'one');removeWidget(config,'omlx');
  assert.equal(installed(config,'omlx'),false);assert.equal(placements(config,'omlx').length,0);
  assert.equal(config.sources.length,3);
  config.plugins=['plugin.custom','plugin.another'].map(id=>({id,feed:'json'}));
  assert.equal(connectionsFor(config,'plugin.another').length,0);assert.equal(connectionsFor(config,'plugin.custom')[0].id,'endpoint');
  const legacy={id:'legacy',kind:'json'};config.sources.push(legacy);page.slots[2]={...page.slots[2],kind:'plugin.custom',source:'legacy'};
  assert.ok(connectionsFor(config,'plugin.custom').includes(legacy));assert.ok(!connectionsFor(config,'plugin.another').includes(legacy));
});
