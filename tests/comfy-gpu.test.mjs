import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

// Exercise the view's snapshot entry point across successive readings on one card.
async function mount(){
  function element(tag){
    return {tag,children:[],dataset:{},style:{setProperty(name,value){this[name]=value;}},classes:new Set(),
      classList:{toggle(name,on){if(on)this.owner.classes.add(name);else this.owner.classes.delete(name);}},
      append(...children){this.children.push(...children);},
      get firstChild(){return this.children[0];},
      querySelector(name){return this.children.find(child=>child.tag===name);},
      replaceChildren(...children){this.children=children;},setAttribute(){}};
  }
  const roots=new Map();
  const document={hidden:true,querySelector(id){if(!roots.has(id))roots.set(id,element(id));return roots.get(id);},
    createElement(tag){const node=element(tag);node.classList.owner=node;return node;},addEventListener(){}};
  const window={addEventListener(){}};
  const source=await readFile(new URL('../widgets/views/comfy/widget.js',import.meta.url),'utf8');
  vm.runInNewContext(source,{document,window,setInterval(){}});
  const card=roots.get('main').firstChild;
  return {window,card,roots};
}

test('GPU activity drives idle workers only while fresh and above five percent', async()=>{
  const {window,card,roots}=await mount();
  const [node,,track,gpu,queue]=card.children[1].children[1].children;
  function render(percent,age=0,active=null,status='Idle'){
    const worker={name:'Worker',status,queued:0,active,devices:[{name:'NVIDIA Test',type:'cuda'}]};
    if(percent!=null)worker.gpuLoad={percent,at:Date.now()-age};
    window.comfySnapshot({at:Date.now(),workers:[worker]});
  }
  render(98);
  const header=gpu.firstChild.firstChild;
  assert.deepEqual(header.children.map(child=>child.className),['nvidia','cuda-badge','gpu-load']);
  const load=header.children[2];
  assert.equal(queue.className,'queue');
  assert.equal(node.textContent,'Rendering');assert.equal(load.firstChild.textContent,'98%');
  assert.equal(load.style['--load'],'98%');
  assert.ok(track.classes.has('indeterminate'));assert.equal(roots.get('#summary').textContent,'1 rendering · 0 queued');
  for(const percent of [5,0]){
    render(percent);assert.equal(node.textContent,'Ready to render');assert.ok(track.hidden);assert.equal(load.hidden,false);
  }
  render(99,16000);assert.equal(node.textContent,'Ready to render');assert.ok(load.hidden);
  render(99,0,{node:'Sampler',progress:[3,10]},'Rendering');
  assert.equal(node.textContent,'Sampler');assert.equal(track.firstChild.style.width,'30%');assert.ok(!track.classes.has('indeterminate'));
  render(99,0,null,'Offline');assert.ok(load.hidden);assert.equal(node.textContent,'Server unreachable');
  render(null);assert.ok(load.hidden);assert.equal(node.textContent,'Ready to render');
});

test('ComfyUI hardware cards identify Radeon and Arc, including ROCm CUDA aliases',async()=>{
  const {window,card}=await mount();
  const gpu=card.children[1].children[1].children[3];
  for(const [name,type,torch,vendor,backend,model] of [
    ['cuda:0 AMD Radeon AI PRO R9700 : native','cuda','2.8+rocm6.4','AMD','ROCm','Radeon AI PRO R9700'],
    ['xpu:1 Intel(R) Arc(TM) B580 Graphics','xpu','2.8+xpu','Intel','XPU','Arc(TM) B580 Graphics'],
    ['cuda:0 AMD Radeon Graphics : native','cuda','2.8','AMD',null,'Radeon Graphics']
  ]){
    window.comfySnapshot({at:Date.now(),workers:[{status:'Idle',hardware:{torch,ram:1024,ramFree:256},
      devices:[{name,type,total:512,free:128}]}]});
    const panel=gpu.firstChild,header=panel.firstChild;
    assert.equal(panel.dataset.vendor,vendor);assert.equal(header.firstChild.textContent,vendor);
    assert.equal(panel.children[1].textContent,model);
    assert.equal(header.children.find(child=>child.className==='backend-badge')?.textContent??null,backend);
    assert.equal(panel.children[3].firstChild.textContent,'GPU RAM');
    assert.equal(panel.children[4].firstChild.textContent,'Host RAM');
  }
});
