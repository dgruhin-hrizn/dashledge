import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

test('HID hits the iframe control in widget coordinates and drags its scroll pane',async()=>{
  const source=await readFile(new URL('../ui/touch.js',import.meta.url),'utf8');
  let clicked=0,scrolled=0;
  const events=[];
  class Event {constructor(type, options){this.type=type;Object.assign(this,options)}}
  const widgetWindow={MouseEvent:Event,PointerEvent:Event,getComputedStyle:()=>({overflowY:'auto',overflowX:'hidden'})};
  const button={tagName:'BUTTON',classList:{add(){},remove(){}},isConnected:true,
    scrollHeight:400,clientHeight:120,scrollBy:(_,y)=>{scrolled+=y},
    closest:selector=>selector.startsWith('input')?null:button,
    dispatchEvent:event=>events.push(event),click:()=>clicked++};
  const widget={defaultView:widgetWindow,elementFromPoint:(x,y)=>x>=0&&y>=0?button:null};
  button.ownerDocument=widget;
  const frame={tagName:'IFRAME',contentDocument:widget,offsetWidth:800,offsetHeight:200,clientLeft:0,clientTop:0,
    getBoundingClientRect:()=>({left:100,top:50,width:800,height:200})};
  const window={addEventListener(){},dispatchEvent(){}};
  vm.runInNewContext(source,{window,document:{elementFromPoint:()=>frame},CustomEvent:Event});
  window.__edgeTouch('down',135,93);window.__edgeTouch('up',135,93);
  assert.equal(clicked,1);assert.deepEqual(events.map(e=>[e.type,e.clientX,e.clientY]),[
    ['pointerdown',35,43],['pointerup',35,43],['mousedown',35,43],['mouseup',35,43],
  ]);
  window.__edgeTouch('down',135,160);window.__edgeTouch('move',135,110);window.__edgeTouch('up',135,110);
  assert.equal(scrolled,50);assert.equal(clicked,1);
});

test('physical report sequences page in both directions inside widgets while preserving scroll and taps',async()=>{
  const script=await readFile(new URL('../ui/touch.js',import.meta.url),'utf8');
  class Event{constructor(type,options){this.type=type;Object.assign(this,options)}}
  const pages=[],pointers=[];let clicks=0,pickers=0,modal=false;
  const button={tagName:'BUTTON',isConnected:true,classList:{add(){},remove(){}},closest:q=>q.startsWith('input')?null:button,
    dispatchEvent:e=>pointers.push(e.type),click:()=>clicks++,scrollWidth:100,clientWidth:100,scrollLeft:0,
    scrollBy(dx){this.scrollLeft+=dx}};
  const widget={elementFromPoint:()=>button,querySelector:()=>modal,defaultView:{PointerEvent:Event,MouseEvent:Event,getComputedStyle:()=>({overflowX:'auto',overflowY:'auto'})}};
  button.ownerDocument=widget;
  const frame={tagName:'IFRAME',contentDocument:widget,offsetWidth:2560,offsetHeight:720,clientLeft:0,clientTop:0,
    getBoundingClientRect:()=>({left:0,top:0,width:2560,height:720})};
  const win={innerWidth:2560,innerHeight:720,addEventListener(){},dispatchEvent:e=>{if(e.type==='edgepageswipe')pages.push(e.detail);if(e.type==='edgepagepicker')pickers++}};
  vm.runInNewContext(script,{window:win,document:{elementFromPoint:()=>frame},CustomEvent:Event});
  function drag(x1,y1,x2,y2){win.__edgeTouch('down',x1,y1);win.__edgeTouch('move',(x1+x2)/2,(y1+y2)/2);win.__edgeTouch('up',x2,y2)}
  drag(1400,240,1100,250);drag(800,250,1090,210);
  assert.deepEqual(pages,[1,-1]);assert.equal(clicks,0);assert.equal(pointers.filter(e=>e==='pointercancel').length,2);
  drag(500,240,525,450);drag(500,240,525,244);assert.equal(pages.length,2);
  button.scrollWidth=500;button.scrollLeft=60;drag(500,250,320,245);
  assert.equal(button.scrollLeft,150);assert.equal(pages.length,2);
  drag(2545,240,2310,240);assert.deepEqual(pages,[1,-1,1]);assert.equal(button.scrollLeft,150);
  button.scrollLeft=400;drag(500,240,330,240);assert.equal(pages.length,4);
  modal=true;drag(2540,240,2200,240);assert.equal(pages.length,4);modal=false;
  drag(600,240,600,240);assert.equal(clicks,1);
  // A mapped widget button at the bezel takes its own tap, even at the picker location.
  drag(5,360,7,362);assert.equal(clicks,2);assert.equal(pickers,0);
  drag(4,360,240,360);assert.equal(clicks,2);assert.equal(pages.at(-1),-1);assert.equal(pickers,0);
});
