const valid=v=>typeof v==='string' && /^\d+(?:\.\d+){1,3}$/.test(v);
const compare=(a,b)=>a.localeCompare(b,'en',{numeric:true});
const releases='https://api.github.com/repos/MediaBrowser/Emby.Releases/releases';
export async function updateDetails(info,local,publicJson) {
  const explicit=[info.AvailableVersion,info.LatestVersion].find(v=>valid(v)&&valid(info.Version)&&compare(v,info.Version)>0);
  let version=explicit, notes='';
  const channel=info.SystemUpdateLevel?.toLowerCase();
  let rows=[];
  try {rows=await local('System/ReleaseNotes/Versions');} catch {}
  if(!Array.isArray(rows)) rows=[];
  const packages=rows.map(p=>({v:p.versionStr??p.VersionStr,notes:p.description??p.Description,channel:String(p.classification??p.Classification??'').toLowerCase()}));
  if(!version && valid(info.Version) && channel){
    version=packages.filter(p=>valid(p.v)&&compare(p.v,info.Version)>0&&(p.channel==='release'||p.channel===channel))
      .sort((a,b)=>compare(b.v,a.v))[0]?.v;
  }
  notes=packages.find(p=>p.v===version)?.notes;
  if(!version || !notes){
    try {
      let release;
      if(version) release=await publicJson(releases+'/tags/'+version);
      else if(valid(info.Version)&&['release','beta'].includes(channel)){
        const items=await publicJson(channel==='release'?releases+'/latest':releases+'?per_page=12');
        release=[].concat(items).filter(r=>!r.draft&&valid(r.tag_name)&&compare(r.tag_name,info.Version)>0&&(channel==='beta'||!r.prerelease)).sort((a,b)=>compare(b.tag_name,a.tag_name))[0];
      }
      if(valid(release?.tag_name)&&(!version || version===release.tag_name)){version=release.tag_name;notes=release.body;}
    } catch {}
  }
  return {version,notes:typeof notes==='string'?notes.slice(0,60000):'',catalog:!!version&&!explicit};
}
