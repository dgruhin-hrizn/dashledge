export async function reportingRanks(url,headers){
  const sql="SELECT ItemId, MAX(ItemName), SUM(PlayDuration) AS watched FROM PlaybackActivity WHERE DateCreated >= datetime('now','localtime','-7 days') AND ItemType IN ('Movie','Episode') AND PlayDuration > 0 GROUP BY ItemId ORDER BY watched DESC, ItemId LIMIT 8";
  const response=await fetch(url,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({CustomQueryString:sql,ReplaceUserId:false}),redirect:'error',signal:AbortSignal.timeout(4000)});
  if(!response.ok)throw Error('Reporting unavailable');
  const data=await response.json(), rows=data.results??data.Results;
  if(!Array.isArray(rows)||/error|exception/i.test(data.message??data.Message??''))throw Error('Invalid report');
  return rows.map(([id,name,seconds])=>({id:String(id),name,seconds:Number(seconds)})).filter(r=>r.id&&r.seconds>0);
}

export async function viewerRanks(get,now){
  const users=await get('Users');
  const titles=new Map(), cutoff=now-7*86400000;
  for(const user of users){
    const seen=new Set();
    for(let start=0;;start+=100){
      const query=new URLSearchParams({Recursive:'true',IncludeItemTypes:'Movie,Episode',SortBy:'DatePlayed',SortOrder:'Descending',EnableUserData:'true',EnableImages:'false',Limit:'100',StartIndex:String(start)});
      const {Items:items,TotalRecordCount:count}=await get('Users/'+encodeURIComponent(user.Id)+'/Items?'+query);
      let reachedCutoff=false;
      for(const item of items){
        const date=Date.parse(item.UserData?.LastPlayedDate);
        if(!Number.isFinite(date)||date<cutoff){reachedCutoff=true;continue;}
        if(date>now||!item.Id||seen.has(item.Id))continue;
        seen.add(item.Id);
        const title=titles.get(item.Id)??{id:item.Id,name:[item.SeriesName,item.Name].filter(Boolean).join(' · '),viewers:0,last:0};
        title.viewers++;title.last=Math.max(title.last,date);titles.set(item.Id,title);
      }
      if(reachedCutoff||items.length<100||start+items.length>=count)break;
      if(start>=9900)throw Error('Playback history pagination limit');
    }
  }
  return [...titles.values()].sort((a,b)=>b.viewers-a.viewers||b.last-a.last||a.id.localeCompare(b.id)).slice(0,8);
}
