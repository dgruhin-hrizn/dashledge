import assert from 'node:assert/strict';
import test from 'node:test';
import {decodeClip,frameAt,unpack,groupOf,eligible,timeText,scheduledSleep,sleepOverride,sleeping} from '../ui/rundmd/model.js';

test('Run-DMD preserves bitmap reuse, transparency and clock window endpoints',()=>{
  const b=new Uint8Array(9+6+2048);b.set([1,1,1,0,0,0,1,1,3,1,50,0,33,1,105,0xfa]);
  const clip=decodeClip(b),pixels=new Uint8Array(4096);
  assert.equal(clip.fourShade,true);
  const shaded=b.slice();shaded[shaded.length-1]=0x27;assert.equal(decodeClip(shaded).fourShade,false);
  assert.equal(clip.layer,1);assert.equal(clip.first,0);assert.equal(clip.last,0);
  assert.deepEqual(clip.frames.map(f=>f.end),[100,166,576]);
  assert.deepEqual([0,99,100,166,575,576].map(t=>frameAt(clip,t)),[0,0,1,2,2,3]);
  unpack(clip.pixels,1,pixels);assert.deepEqual([...pixels.slice(0,2)],[15,10]);
  unpack(clip.pixels,0,pixels);assert.ok(pixels.every(p=>p===10));
  b[9]=2;assert.throws(()=>decodeClip(b),/bitmap/);
});

test('group names preserve game numbers and per-clip overrides respect Show all',()=>{
  assert.equal(groupOf('TERMINATOR_2_007'),'TERMINATOR_2');
  const clips=[{name:'24_001',enabled:false},{name:'24_002',enabled:true}];
  assert.deepEqual(eligible(clips,{overrides:{}}),[1]);
  assert.deepEqual(eligible(clips,{overrides:{'24_001':true,'24_002':false}}),[0]);
  assert.deepEqual(eligible(clips,{filter:'all',overrides:{}}),[0,1]);
});

test('scheduled standby crosses midnight and manual wake lasts to the next boundary',()=>{
  const p={sleep:'22:00',wake:'07:00'};
  const at=(day,h,m=0)=>new Date(2026,10,day,h,m);
  assert.ok(scheduledSleep(at(25,23),p));
  p.manualSleep=sleepOverride(at(25,23),p);assert.equal(sleeping(at(26,1),p),false);
  assert.equal(sleeping(at(26,8),p),false);assert.equal(sleeping(at(26,22),p),true);
  assert.equal(timeText(at(25,0),'12ap'),'12:00 AM');assert.equal(timeText(at(25,12),'12ap'),'12:00 PM');
});

test('each animation cell occupies one LED across the full widget',async()=>{
  const {matrixGeometry}=await import('../ui/rundmd/display.js');
  for(const [width,height] of [[2560,720],[1024,256],[301,163]]){
    const {pitchX,pitchY,radius}=matrixGeometry(width,height);
    assert.equal(128*pitchX,width);
    assert.equal(32*pitchY,height);
    assert.equal(radius,Math.min(pitchX,pitchY)*.38);
  }
});

test('PINBALL time uses native dot masks, stable separator positions and a baseline-aligned period',async()=>{
  const {drawPinballClock}=await import('../ui/rundmd/pinball.js');
  const frame=(label,separator=true)=>{
    const dots=new Set();
    drawPinballClock({fillRect(x,y,w,h){
      assert.deepEqual([w,h],[1,1]);assert.ok(x>=0&&x<128&&y>=0&&y<32);
      dots.add(x+','+y);
    }},label,separator,255);
    return dots;
  };
  const lit=frame('10:52 PM'),unlit=frame('10:52 PM',false);
  const removed=[...lit].filter(dot=>!unlit.has(dot));
  assert.equal(removed.length,18);
  const rows=dots=>[...new Set(dots.map(dot=>Number(dot.split(',')[1])))].sort((a,b)=>a-b);
  assert.deepEqual(rows(removed),[11,12,13,18,19,20]);
  assert.deepEqual(rows([...lit]),Array.from({length:18},(_,i)=>7+i));
  const pm=[...lit].filter(dot=>Number(dot.split(',')[0])>=85);
  assert.deepEqual(rows(pm),Array.from({length:10},(_,i)=>15+i));
  const screenshots=new Set(Array.from({length:10},(_,n)=>[...frame('10:0'+n)].join(' ')));
  assert.equal(screenshots.size,10);
  assert.ok(frame('23:59:59').size>0);
  assert.equal(timeText(new Date(2026,10,26,7,5),'12ap'),'7:05 AM');
});
