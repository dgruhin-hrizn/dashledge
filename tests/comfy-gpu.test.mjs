import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

// Exercise the view's snapshot entry point across successive readings on one card.
test('GPU activity drives idle workers only while fresh and above five percent', async()=>{
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
