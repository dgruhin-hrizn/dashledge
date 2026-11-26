// Set or verify the release version across Node, Tauri and Cargo manifests.
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

process.chdir(fileURLToPath(new URL('../',import.meta.url)));
const read=path=>readFileSync(path,'utf8');
const version=process.argv[2]||JSON.parse(read('package.json')).version;
if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw Error('Expected a stable version such as 0.6.0');
for(const file of ['package.json','package-lock.json','src-tauri/tauri.conf.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock']){
  const source=read(file);
  let next;
  if(file.endsWith('.json')){
    const json=JSON.parse(source);
    json.version=version;
    if(file==='package-lock.json') json.packages[''].version=version;
    next=JSON.stringify(json,null,2)+'\n';
  }else{
    const pattern=file.endsWith('.lock')?/(\[\[package\]\]\nname = "edge-starter"\nversion = ")[^"]+"/:/(\[package\]\nname = "edge-starter"\nversion = ")[^"]+"/;
    if(!pattern.test(source))throw Error('Missing package version in '+file);
    next=source.replace(pattern,(_,prefix)=>prefix+version+'"');
  }
  if(next===source)continue;
  if(!process.argv[2])throw Error('Version mismatch in '+file);
  writeFileSync(resolve(file),next);
}
console.log(version);
