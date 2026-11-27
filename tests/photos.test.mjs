import test from 'node:test';
import assert from 'node:assert/strict';
import {normalize,rememberNames,blocker,searchAlbums,fitMode,cropLoss,bestFit,assign,justify,
  sizeFor,focusPosition,dateCaption,freshFirst,remember,shape,heartState,favoriteError,withoutIds} from '../ui/photo-settings.js';

test('saved placements keep their theme and albums across versions',()=>{
  const old=normalize({source:'albums',albums:['a','b','a'],theme:'film',direction:'right',speed:'fast'});
  assert.equal(old.theme,'film');assert.deepEqual(old.albums,['a','b']);
  assert.equal(old.direction,'right');assert.equal(old.captions,true);assert.equal(old.skipScreenshots,true);
  assert.equal(normalize({theme:'gone'}).theme,'montage');
  assert.equal(normalize(null).theme,'cinema');
  const objects=normalize({albums:[{id:'x',name:'Trips'}]});
  assert.deepEqual(objects.albums,['x']);assert.deepEqual(objects.albumNames,{x:'Trips'});
  assert.equal(normalize({captions:false}).captions,false);
});

test('album names are remembered for albums Photos no longer lists',()=>{
  const s=normalize({source:'albums',albums:['a','gone'],albumNames:{gone:'Old trip'}});
  const named=rememberNames(s,{albums:[{id:'a',name:'Beach'}]});
  assert.deepEqual(named.albumNames,{a:'Beach',gone:'Old trip'});
});

test('Save explains what blocks it',()=>{
  const catalog={access:'allowed',sharedSupported:false,albums:[{id:'a',name:'A',count:0},{id:'b',name:'B',count:3}]};
  assert.equal(blocker(normalize({}),null),'Reading Photos…');
  assert.match(blocker(normalize({}),{access:'denied'}),/Allow Photos/);
  assert.match(blocker(normalize({source:'albums'}),catalog),/at least one/);
  assert.match(blocker(normalize({source:'albums',albums:['zz']}),catalog),/any more/);
  assert.match(blocker(normalize({source:'albums',albums:['a']}),catalog),/no photos/);
  assert.equal(blocker(normalize({source:'albums',albums:['a','b','zz']}),catalog),null);
  assert.match(blocker(normalize({source:'shared'}),catalog),/Shared Library/);
});

test('album search matches folder paths',()=>{
  const albums=[{name:'Beach',folder:'Trips › 2023'},{name:'Dogs',folder:''}];
  assert.equal(searchAlbums(albums,'trips').length,1);assert.equal(searchAlbums(albums,' ').length,2);
});

test('photos are fitted by aspect ratio',()=>{
  assert.equal(shape(4),'panorama');assert.equal(shape(.66),'portrait');assert.equal(shape(1),'square');
  // A portrait in a 32:9 Edge would lose most of itself: show it whole.
  assert.equal(fitMode(3/4,2560/720),'contain');
  assert.equal(fitMode(16/9,2560/1440),'cover');
  assert.ok(Math.abs(cropLoss(1,2)-.5)<1e-9);
  const pool=[{w:3,h:4},{w:16,h:9},{w:1,h:1}];
  assert.equal(bestFit(pool,1.7),1);assert.equal(bestFit(pool,.7),0);
  const placed=assign([{id:'p',w:2,h:3},{id:'l',w:3,h:2},{id:'pan',w:4,h:1}],[3.5,.7,1.4]);
  assert.deepEqual(placed.map(p=>p.id),['pan','p','l']);
});

test('justified rows fill the box at each photo’s own shape',()=>{
  const {rects,used}=justify([1.5,.75,1,1.5,1.5,.66,1.33,1],2560,720,{rows:2,gap:8});
  assert.ok(used>=4);
  const rows=[...new Set(rects.map(r=>Math.round(r.y)))];
  assert.equal(rows.length,2);
  for(const y of rows){
    const row=rects.filter(r=>Math.round(r.y)===y),right=row.at(-1);
    assert.ok(Math.abs(right.x+right.w-2560)<1,'row fills the width');
  }
  const bottom=Math.max(...rects.map(r=>r.y+r.h));assert.ok(Math.abs(bottom-720)<1);
  for(const r of rects){const ratio=r.w/r.h;assert.ok(ratio>0)}
});

test('image size follows the opening and pixel density',()=>{
  assert.equal(sizeFor(2560,720,32/9,1),2560);
  // Shown whole (a 16:9 photo on 32:9), so only as large as it's drawn.
  assert.equal(sizeFor(2560,720,16/9,1),1600);
  // A portrait contained on the Edge is drawn 720 tall, not 4500.
  assert.equal(sizeFor(2560,720,.56,1),1024);
  assert.equal(sizeFor(300,200,1.5,2),1024);
  assert.equal(sizeFor(9000,9000,1,2),3072);
});

test('captions, focus and repeat avoidance',()=>{
  assert.equal(focusPosition({x:.25,y:1.4}),'25% 100%');assert.equal(focusPosition(null),'50% 42%');
  const when=Date.UTC(2019,5,14,12)/1000;
  assert.match(dateCaption(when,{now:Date.UTC(2026,5,14),relative:true,locale:'en-US'}),/June 14, 2019 · 7 years ago/);
  assert.equal(dateCaption(0),'');
  const order=freshFirst([{id:'a'},{id:'b'},{id:'c'}],['a']);assert.deepEqual(order.map(a=>a.id),['b','c','a']);
  let seen=[];for(let i=0;i<5;i++)seen=remember(seen,'x'+i,3);seen=remember(seen,'x3',3);
  assert.deepEqual(seen,['x2','x4','x3']);
});

test('the heart says what tapping it will do',()=>{
  assert.deepEqual(heartState(true),{pressed:'true',label:'Remove from Favorites'});
  assert.deepEqual(heartState(false),{pressed:'false',label:'Favorite'});
  assert.deepEqual(heartState(undefined),heartState(false));
});

test('a failed heart explains itself',()=>{
  assert.match(favoriteError(Error('Allow Photos access in System Settings → Privacy & Security → Photos.')),/to change Favorites/);
  assert.equal(favoriteError('Photos in shared albums can’t be marked as Favorites.'),'Couldn’t update Favorites. Photos in shared albums can’t be marked as Favorites.');
  assert.equal(favoriteError(null),'Couldn’t update Favorites.');
});

test('un-hearted photos leave a Favorites deck',()=>{
  const assets=[{id:'a'},{id:'b'},{id:'c'}];
  assert.deepEqual(withoutIds(assets,new Set(['b'])).map(a=>a.id),['a','c']);
  assert.equal(withoutIds(assets,new Set()),assets);
  assert.equal(withoutIds(assets,null),assets);
});
