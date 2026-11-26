import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

test('Apple Music draws live bands by default and respects a saved Off setting',async()=>{
  const source=await readFile(new URL('../ui/spotify-spectrum.js',import.meta.url),'utf8');
  let setting=null,calls=0,bars=0,tick;
  const rail={getBoundingClientRect:()=>({top:110,height:4}),offsetHeight:4};
  const canvas={parentElement:rail,style:{},width:512,height:84,getContext:()=>({
    clearRect(){},fillRect(){bars++}
  })};
  const button={},title={getBoundingClientRect:()=>({bottom:40})};
  const box={isConnected:true,closest:()=>null,querySelector:s=>s==='.sp-title'?title:button};
  const realm=vm.createContext({
    localStorage:{getItem:key=>{assert.equal(key,'edge.applemusic.spectrum');return setting}},
    document:{hidden:false},getComputedStyle:()=>({color:'white'}),setTimeout:fn=>{tick=fn},
    invoke:async(method,args)=>{
      assert.equal(method,'spotify_spectrum');assert.equal(args.apple,true);calls++;
      return Array(32).fill(130);
    }
  });
  vm.runInContext(source.replace(/^import .*?;$/gm,'').replace('export function','function'),realm);
  const update=realm.mountSpectrum(canvas,{textContent:''},box,'applemusic');
  update(true);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,1);assert.ok(bars>32);assert.equal(canvas.style.height,'66px');
  setting='off';update(true);tick();assert.equal(calls,1);
});
