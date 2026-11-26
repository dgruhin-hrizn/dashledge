import test from 'node:test';
import assert from 'node:assert/strict';
import {readPlaylistPage,cachedPlaylists} from '../ui/apple-playlist-index.js';

test('native pagination shares concurrent reads, advances past folders and caches partial results',async()=>{
  const calls=[];
  const row=n=>({id:String(n),key:'k'+n,name:'Mix '+n});
  async function request(action,offset,limit){
    calls.push([action,offset,limit]);
    return {rows:offset?[row(3),row(4)]:[row(1)],library:'local',total:4,next:offset?null:2};
  }
  const [first,copy]=await Promise.all([readPlaylistPage(request,null,2),readPlaylistPage(request,null,2)]);
  assert.equal(first,copy);assert.equal(cachedPlaylists().next,2);
  const last=await readPlaylistPage(request,first,192);
  assert.deepEqual(calls,[['playlists',0,2],['playlists',2,12]]);
  assert.deepEqual(last.rows.map(p=>p.key),['k1','k3','k4']);assert.equal(last.next,null);
  await assert.rejects(readPlaylistPage(async()=>({rows:[],next:null,library:'other',total:4}),first,2),/library changed/);
});
