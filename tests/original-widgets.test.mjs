import './helpers/bundled-packages.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {addOriginalPages,initial,originalKinds} from '../ui/model.js';
import {widgetSources} from '../ui/original-widgets.js';
import {modelControls} from '../widgets/packages/omlx/collector/model-control.mjs';

test('upgrade adds missing full-screen dashboards once and honors later edits', () => {
  const layout=initial();
  const existing=structuredClone(layout.pages);
  assert.equal(addOriginalPages(layout),true);
  assert.deepEqual(layout.pages.slice(0,existing.length),existing);
  for(const kind of originalKinds)assert.equal(layout.pages.filter(p=>p.slots.length===1&&p.slots[0].kind===kind).length,1);
  layout.pages.pop();const edited=structuredClone(layout);
  assert.equal(addOriginalPages(layout),false);assert.deepEqual(layout,edited);
});

test('the worker wall and server selector start with the assigned endpoint',()=>{
  const sources=['a','b','c','duplicate'].map(id=>({kind:'comfy',id,name:id,address:'http://'+(id==='duplicate'?'a':id)+'/'}));
  const names=(kind,ids)=>widgetSources(kind,'b',ids).map(s=>s.name);
  assert.deepEqual(names('comfy',sources),['b','a']);
  assert.deepEqual(names('omlx',sources.map(s=>({...s,kind:'omlx'}))),['b','a','c']);
  assert.deepEqual(widgetSources('comfy','removed',sources),[]);
});

test('model action uses the selected server, acknowledges the viewer and consumes a tap once',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'workbench-model-'));
  try {
    const address='http://fixture.test', viewer='omlx-dashboard@fixture';
    const tap={id:'f'.repeat(32),at:Date.now(),action:'unload',address,model:'example'};
    const calls=[];
    const controls=await modelControls({state:join(dir,'claims.json'),preferences:()=>({widgetStorage:{[viewer]:{'omlx.modelAction':JSON.stringify(tap)}}}),fetchApi:async(url,options)=>{
      calls.push([url,options.method]);return {status:202,ok:true};
    }});
    const inventory=[{address,canControl:true,models:[{id:'example',loaded:true,controllable:true}]}];
    await controls.consume([{origin:address}],inventory);
    await controls.consume([{origin:address}],inventory);
    assert.deepEqual(calls,[[address+'/admin/api/models/example/unload','POST']]);
    assert.equal(controls.receipts()[viewer].id,tap.id);
    assert.equal(controls.receipts()[viewer].status,'success');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('ComfyUI reuses only GPU SSH mappings for the exact worker hostname',()=>{
  const guests={a:{target:'user@compute.test',identityFile:'/fixture/key'},b:'other.test'};
  const sources=[{id:'a',kind:'comfy',name:'Worker',address:'https://compute.test:8188'},
    {id:'b',kind:'comfy',name:'Other',address:'http://notcompute.test:8188'},
    {kind:'proxmox',gpuGuests:guests}];
  const [mapped,plain]=widgetSources('comfy','a',sources);
  assert.deepEqual(mapped.gpuGuests,{worker:guests.a});
  assert.equal(plain.gpuGuests,undefined);
});
