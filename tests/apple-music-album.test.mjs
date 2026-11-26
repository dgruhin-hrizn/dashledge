import test from 'node:test';
import assert from 'node:assert/strict';
import {albumTracks,followingAlbumTracks} from '../ui/apple-music-art.js';

const song=(title,disc,number)=>({artist:'Artist',title,disc,number});
test('album order crosses discs, stops at the end, and wraps only on context repeat',()=>{
  const a=song('A',1,1),b=song('B',1,2),c=song('C',2,1),tracks=[c,b,a];
  assert.deepEqual(followingAlbumTracks(tracks,b),[c]);
  assert.deepEqual(followingAlbumTracks(tracks,c),[]);
  assert.deepEqual(followingAlbumTracks(tracks,{...c,repeat:'context'}),[a,b,c]);
  assert.equal(followingAlbumTracks(tracks,{...a,shuffle:true}),null);
  assert.equal(followingAlbumTracks(tracks,{...a,repeat:'track'}),null);
  assert.equal(followingAlbumTracks([a,a,b],a),null);
  assert.equal(followingAlbumTracks([a,c],{...a,trackCount:2}),null);
});
test('catalog album fills missing library tracks and preserves playable library IDs',async()=>{
  const a=song('A',1,1),b=song('B',1,2),c=song('C',1,3);
  const request=async action=>({'library-album':[{...a,uri:'12'},{...c,uri:'13'}],
    'catalog-art':{collectionId:42},'catalog-album':[a,b,c]})[action];
  const rows=await albumTracks(request,{...a,album:'Release',trackCount:3,discCount:1});
  assert.deepEqual(followingAlbumTracks(rows,a),[b,{...c,uri:'13'}]);
});
