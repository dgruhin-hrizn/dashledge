import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {dimensions} from '../ui/general.js';
import {layout} from '../ui/model.js';

test('portrait uses the rotated Zurface reference canvas and transposes asymmetric split layouts without changing saved regions',()=>{
  assert.deepEqual(dimensions(false),[1920,540]);
  assert.deepEqual(dimensions(true),[540,1920]);
  const regions=[{x:0,y:0,w:.7,h:1},{x:.7,y:0,w:.3,h:.5},{x:.7,y:.5,w:.3,h:.5}];
  const copy=structuredClone(regions);
  const grid={style:{},children:regions.map(()=>({style:{}}))};
  layout(grid,'Featured',regions,true);
  assert.deepEqual(grid.children.map(c=>[c.style.gridColumn,c.style.gridRow]),[['1 / 3','1 / 2'],['1 / 2','2 / 3'],['2 / 3','2 / 3']]);
  assert.deepEqual(regions,copy);
});
test('a mounted original receives live appearance changes and keeps its viewer identity',async()=>{
  const script=await readFile(new URL('../ui/widget-bridge.js',import.meta.url),'utf8');
  const props=new Map(),events=new Map(),frame={dataset:{viewer:'fixture'}};
  let prefs={primary:'#812345',accent:'#6789ab'};
  const window={frameElement:frame,addEventListener:(name,cb)=>events.set(name,cb)};
  vm.runInNewContext(script,{window,document:{documentElement:{style:{setProperty:(k,v)=>props.set(k,v)}}},localStorage:{getItem:()=>JSON.stringify(prefs)}});
  const records=[],stop=window.Zurface.subscribe(s=>records.push(s));
  prefs={primary:'#001122',accent:'#334455'};events.get('storage')({key:'edge.general.v1'});
  assert.equal(records.length,2);assert.equal(records[1].theme.primary,prefs.primary);assert.equal(props.get('--accent'),prefs.accent);
  assert.equal(records[1].instanceID,records[0].instanceID);
  stop();events.get('storage')({key:'edge.general.v1'});assert.equal(records.length,2);
});

import {measurement,animateReading} from '../ui/metric-reading.js';
test('system readouts keep a fixed precision across digit and rate-unit boundaries',()=>{
  for(const [n,i,f] of [[0,'00','0'],[9.95,'10','0'],[99.9,'99','9'],[99.95,'100','0']]){
    const m=measurement(n,'percent');assert.equal(m.integer,i);assert.equal(m.fraction.at(-1),f);assert.equal(m.unit,'%');
  }
  assert.equal(measurement(null,'percent').integer,'—');assert.equal(measurement(128*2**30,'memory').integer,'128');
  for(const [n,i,unit] of [[999.94,'999','B/s'],[999.96,'1','KB/s'],[999960,'1','MB/s']]){
    const m=measurement(n,'rate');assert.equal(m.integer,i);assert.equal(m.unit,unit);
  }
});
test('readouts settle in one second, retarget from the shown value, and resume at the latest sample',()=>{
  let time=0,next=null,shown,motion=false;
  const run=animateReading(n=>{shown=n},{now:()=>time,request:cb=>{next=cb;return 1},cancel:()=>{next=null},immediate:()=>motion});
  const tick=t=>{time=t;const cb=next;next=null;cb?.(time)};
  run.update(9,'percent');assert.equal(shown,9);
  time=100;run.update(100,'percent');tick(600);assert.equal(shown,54.5);
  run.update(0,'percent');tick(1100);assert.equal(shown,27.25);tick(1600);assert.equal(shown,0);assert.equal(next,null);
  time=8000;run.update(81,'percent');assert.equal(shown,81);motion=true;run.update(15,'percent');assert.equal(shown,15);
  run.update(null,'percent');assert.equal(shown,null);
});

test('Edge and preview use the same Zurface scale and map HID taps back to the widget canvas',async()=>{
  const {fitDashboard,displayTouch}=await import('../ui/general.js');
  const before={localStorage:globalThis.localStorage,window:globalThis.window,ResizeObserver:globalThis.ResizeObserver};
  let vertical=false;
  globalThis.localStorage={getItem:()=>JSON.stringify({vertical})};
  globalThis.window={addEventListener(){},removeEventListener(){}};
  globalThis.ResizeObserver=class{observe(){}disconnect(){}};
  try{
    for(const [portrait,w,h,ratio] of [[false,2560,720,4/3],[true,720,2560,4/3],[false,960,270,.5]]){
      vertical=portrait;
      const [cw,ch]=dimensions(vertical),events=[];
      const screen={style:{},dataset:{},clientWidth:w,clientHeight:h};
      const frame={style:{},clientWidth:cw,clientHeight:ch,getBoundingClientRect:()=>({left:18,top:42,right:w+18,bottom:h+42,width:w,height:h}),contentWindow:{__edgeTouch:(...args)=>events.push(args)}};
      const dispose=fitDashboard(screen,frame,true),touch=displayTouch(frame);
      assert.equal(frame.style.width,cw+'px');assert.equal(frame.style.height,ch+'px');assert.equal(frame.style.transform,'translate(-50%,-50%) scale('+ratio+')');
      touch('down',18+w/4,42+h/2);touch('up',18+w/4,42+h/2);
      assert.deepEqual(events,[['down',cw/4,ch/2],['up',cw/4,ch/2]]);
      touch('down',0,0);touch('up',18+w/4,42+h/2);assert.equal(events.length,2);
      touch('down',18+w/4,42+h/2);touch('move',18+w/2,42+h/2);touch('up',w+20,42+h/2);
      assert.equal(events.at(-1)[0],'up');dispose();
    }
  }finally{for(const [k,v] of Object.entries(before)){if(v===undefined)delete globalThis[k];else globalThis[k]=v}}
});
