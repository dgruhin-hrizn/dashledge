import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the actual poll callbacks in a webview-like realm and control reply order.
test('playlist switches reject late queue replies even with identical opening tracks',async()=>{
  const source=await readFile(new URL('../ui/spotify.js',import.meta.url),'utf8');
  let finishOld;
  const realm=vm.createContext({
    performance,localStorage:{getItem:()=> 'client'},
    invoke:async method=>{
      assert.equal(method,'spotify_queue');
      return new Promise(resolve=>{finishOld=resolve});
    },
  });
  vm.runInContext(source.replace(/^import .*?;$/gm,'').replace('export function renderSpotify','function renderSpotify'),realm);
  const evaluate=code=>vm.runInContext(code,realm);
  evaluate("player={context:'spotify:playlist:old',uri:'same-first-track'}");
  const pending=evaluate("readQueue('client',currentQueueKey())");
  evaluate("player={context:'spotify:playlist:new',uri:'same-first-track'}");
  finishOld({current:'same-first-track',items:[{title:'Old queue'}]});
  await pending;
  assert.equal(evaluate('queue.items'),undefined);
  const fresh=evaluate("readQueue('client',currentQueueKey())");
  finishOld({current:'same-first-track',items:[{title:'New queue'}]});
  await fresh;
  assert.equal(evaluate('queue.items[0].title'),'New queue');
});

test('an empty Connect snapshot checks the running Mac player and recovers when Connect resumes',async()=>{
  const source=await readFile(new URL('../ui/spotify.js',import.meta.url),'utf8');
  const local={title:'Loaded track',uri:'spotify:track:local',playing:false};
  let cloud={noPlayback:true},desktop=local;
  const calls=[];
  const realm=vm.createContext({performance,localStorage:{getItem:()=> 'client'},
    invoke:async(method,args)=>{
      calls.push([method,args.action]);
      if(method==='spotify_player')return cloud;
      assert.equal(method,'spotify');assert.equal(args.action,0);return desktop;
    }});
  vm.runInContext(source.replace(/^import .*?;$/gm,'').replace('export function renderSpotify','function renderSpotify'),realm);
  const run=code=>vm.runInContext(code,realm);
  await run('readPlayer()');
  assert.equal(run('player.title'),local.title);
  desktop={};await run('readPlayer()');
  assert.equal(run('player.title'),local.title);
  run('emptySince=Date.now()-7000');await run('readPlayer()');
  assert.equal(run('player.noPlayback'),true);
  assert.equal(run('player.title'),undefined);
  cloud={title:'On the speaker',playing:true};
  await run('readPlayer(1)');
  assert.deepEqual(calls.at(-1),['spotify_player',1]);
  assert.equal(run('player.title'),cloud.title);
});

test('an acknowledged Next preserves the current track until the read poll returns the new one',async()=>{
  const source=await readFile(new URL('../ui/spotify.js',import.meta.url),'utf8');
  const actions=[];
  const realm=vm.createContext({performance,localStorage:{getItem:()=> 'client'},
    invoke:async(method,{action})=>{
      assert.equal(method,'spotify_player');actions.push(action);
      return action?{accepted:true}:{title:'Second track',uri:'second',playing:true};
    }});
  vm.runInContext(source.replace(/^import .*?;$/gm,'').replace('export function renderSpotify','function renderSpotify'),realm);
  const run=code=>vm.runInContext(code,realm);
  run("player={title:'First track',uri:'first',playing:true,error:'Previous error'}");
  await run('readPlayer(2)');
  assert.equal(run('player.title'),'First track');assert.equal(run('player.error'),null);
  assert.equal(run('nextPlayer'),0);
  await run('readPlayer()');
  assert.equal(run('player.title'),'Second track');
  assert.deepEqual(actions,[2,0]);
});

test('pause acknowledgement updates the button while Connect catches up',async()=>{
  const source=await readFile(new URL('../ui/spotify.js',import.meta.url),'utf8');
  let playing=true;
  const realm=vm.createContext({performance,localStorage:{getItem:()=> 'client'},
    invoke:async(_,args)=>args.action?{accepted:true}:{uri:'track',title:'Song',playing}});
  vm.runInContext(source.replace(/^import .*?;$/gm,'').replace('export function renderSpotify','function renderSpotify'),realm);
  const run=code=>vm.runInContext(code,realm);
  await run('readPlayer()');
  await run('readPlayer(1)');
  assert.equal(run('player.playing'),false);
  await run('readPlayer()');
  assert.equal(run('player.playing'),false);
  playing=false;
  await run('readPlayer()');
  assert.equal(run('pendingTransport'),null);
});

test('album playback uses the Spotify player queue including manually queued songs',async()=>{
  const source=await readFile(new URL('../ui/spotify.js',import.meta.url),'utf8');
  const response={current:'now',items:[{title:'Manually queued song'},{title:'Album track two'}]};
  const realm=vm.createContext({localStorage:{getItem:()=> 'client'},invoke:async method=>{
    assert.equal(method,'spotify_queue');return response;
  }});
  vm.runInContext(source.replace(/^import .*?;$/gm,'').replace('export function renderSpotify','function renderSpotify'),realm);
  await vm.runInContext("player={uri:'now',context:'spotify:album:example'};readQueue('client',currentQueueKey())",realm);
  assert.equal(vm.runInContext('queue',realm),response);
});
