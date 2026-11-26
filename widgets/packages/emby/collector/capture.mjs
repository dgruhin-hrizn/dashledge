import {viewerRanks,reportingRanks} from './weekly.mjs';
import {updateDetails} from './updates.mjs';
import {writeFile, rename, mkdir, readdir, stat, unlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

import { context } from '../../_shared/context.mjs';
const { directory, sources: [server] } = context;
const target = server.address.replace(/\/*$/, '/');
const select = (object, fields) => Object.fromEntries(fields.split(' ').filter(k=>object[k]!=null).map(k=>[k,object[k]]));
function artwork(item) {
  if (!item) return;
  const album = item.AlbumId && item.AlbumPrimaryImageTag;
  const id = item.SeriesId || (album ? item.AlbumId : item.Id);
  const tag = item.SeriesPrimaryImageTag || (album ? item.AlbumPrimaryImageTag : item.ImageTags?.Primary);
  if (id) return {path:'Items/'+encodeURIComponent(id)+'/Images/Primary',tag,width:440};
}
function backdrop(item) {
  if (!item) return;
  const own=item.BackdropImageTags?.[0];
  const id=own ? item.Id : item.ParentBackdropItemId;
  const tag=own || item.ParentBackdropImageTags?.[0];
  if(id && tag) return {path:'Items/'+encodeURIComponent(id)+'/Images/Backdrop/0',tag,width:1000};
}
function media(item) {
  return {itemId:item?.Id,overview:item?.Overview,critic:item?.CriticRating,community:item?.CommunityRating,genres:item?.Genres,title:item?.Name, series:item?.SeriesName, year:item?.ProductionYear,
    type:item?.Type, season:item?.ParentIndexNumber, episode:item?.IndexNumber,
    rating:item?.OfficialRating, posterRequest:artwork(item), backdropRequest:backdrop(item)};
}
function playbackMethod(reported,trans) {
  if(trans?.IsVideoDirect===false || trans?.IsAudioDirect===false) return 'Transcode';
  if(trans?.IsVideoDirect===true && trans?.IsAudioDirect===true) return 'Remux';
  if(trans) return reported==='DirectStream'?'DirectStream':reported==='Transcode'?'Transcode':null;
  if(reported==='DirectStream' || reported==='DirectPlay') return 'DirectPlay';
  return reported==='Transcode'?'Transcode':null;
}
function playback(session) {
  const item=session.NowPlayingItem ?? {}, play=session.PlayState ?? {}, trans=session.TranscodingInfo;
  const sources=item.MediaSources ?? [];
  const source=sources.find(src=>src.Id===play.MediaSourceId) ?? (sources.length===1?sources[0]:undefined);
  const tracks=source?.MediaStreams ?? item.MediaStreams ?? [];
  function track(type,index) {
    const matches=tracks.filter(t=>t.Type===type);
    if(index!=null) return matches.find(t=>t.Index===index);
    return matches.find(t=>t.IsDefault) ?? (matches.length===1?matches[0]:undefined);
  }
  const video=track('Video',play.VideoStreamIndex), audio=track('Audio',play.AudioStreamIndex ?? source?.DefaultAudioStreamIndex);
  const method=playbackMethod(play.PlayMethod,trans);
  const mode=direct=>direct===false?'Transcode':direct===true?'Stream copy':method==='DirectPlay'?'Direct play':undefined;
  return {method,container:trans?.Container ?? source?.Container ?? item.Container,
    bitrate:trans?.Bitrate ?? source?.Bitrate ?? item.Bitrate,
    video:video?.DisplayTitle || [video?.Height && video.Height+'p',video?.Codec?.toUpperCase()].filter(Boolean).join(' '),
    audio:audio?.DisplayTitle || [audio?.Language,audio?.Codec?.toUpperCase(),audio?.ChannelLayout].filter(Boolean).join(' '),
    videoMode:mode(trans?.IsVideoDirect),audioMode:mode(trans?.IsAudioDirect),clientVersion:session.ApplicationVersion};
}
export const sources = {
  emby: {
    sessions: ['Sessions', 6, sessions=>sessions.filter(s=>s.UserName && (s.NowPlayingItem || Date.now()-Date.parse(s.LastActivityDate)<900000)).map(s=>{
      const play=s.PlayState || {};
      return {...media(s.NowPlayingItem), id:s.Id, user:s.UserName, client:s.Client, device:s.DeviceName,
        avatarRequest:s.UserId && {path:'Users/'+encodeURIComponent(s.UserId)+'/Images/Primary',tag:s.UserPrimaryImageTag,width:96},
        last:s.LastActivityDate, paused:!!play.IsPaused,
        duration:s.NowPlayingItem?.RunTimeTicks, position:play.PositionTicks, ...playback(s)};
    })],
    recent: ['Items?Recursive=true&IncludeItemTypes=Movie,Series&SortBy=DateCreated&SortOrder=Descending&Limit=8', 600, data=>data.Items.slice(0,8).map(media)],
    info: ['System/Info', 120, v=>select(v,'ServerName Version HasUpdateAvailable HasPendingRestart SystemUpdateLevel AvailableVersion LatestVersion')],
    tasks: ['ScheduledTasks', 30, tasks=>tasks.filter(t=>t.State==='Running').map(t=>({name:t.Name,progress:t.CurrentProgressPercentage}))],
    event: ['System/ActivityLog/Entries?Limit=1', 60, data=>data.Items?.slice(0,1).map(e=>({name:e.Name,at:e.Date}))],
    counts: ['Items/Counts', 600, v=>select(v,'MovieCount SeriesCount EpisodeCount SongCount')],
  }
};
function imageCache(dir,headers) {
  const jobs=new Map();
  async function load(req,file) {
    const path=join(dir,file);
    try {if(Date.now()-(await stat(path)).mtimeMs<86400000) return 'art/'+file;} catch {}
    const url=new URL(req.path,target);
    url.search=new URLSearchParams({MaxWidth:req.width,Quality:84,Format:'jpg',...(req.tag?{Tag:req.tag}:{})});
    const res=await fetch(url,{headers,redirect:'error',signal:AbortSignal.timeout(3000)});
    if(!res.ok || !res.headers.get('content-type')?.startsWith('image/')) return;
    const bytes=Buffer.from(await res.arrayBuffer());
    if(bytes.length>2000000 || bytes[0]!==255 || bytes[1]!==216) return;
    await writeFile(path+'.tmp',bytes,{mode:0o600});
    await rename(path+'.tmp',path);
    return 'art/'+file;
  }
  return async req=>{
    if(!req) return;
    const file=createHash('sha256').update(JSON.stringify(req)).digest('hex').slice(0,32)+'.jpg';
    let entry=jobs.get(file);
    if(!entry || entry.until<Date.now()){
      entry={until:Date.now()+300000,result:load(req,file).catch(()=>undefined)};
      jobs.set(file,entry);
      for(const [key,value] of jobs) if(value.until<Date.now()) jobs.delete(key);
    }
    return entry.result;
  };
}
export async function publish(kind,snapshot) {
  const dir=directory;
  await mkdir(dir,{recursive:true});
  const file=join(dir,'snapshot.js'), tmp=file+'.'+process.pid+'.tmp';
  await writeFile(tmp,'window.serverSnapshot?.('+JSON.stringify(snapshot)+');\n',{mode:0o600});
  await rename(tmp,file);
}
async function run(kind) {
  const key=server.key;
  const headers={'X-Emby-Token':key || ''};
  const dir=join(directory,'art');
  await mkdir(dir,{recursive:true,mode:0o700});
  const image=imageCache(dir,headers);
  const sections={}, due={};
  let cleanupAt=0, releaseKey='', releaseUntil=0, release;
  const rates=[];
  async function json(url,h) {
    const response=await fetch(url,{headers:h,redirect:'error',signal:AbortSignal.timeout(4000)});
    if(!response.ok)throw Error('HTTP '+response.status);
    return response.json();
  }
  const catalog=new Map();
  async function lookup(ids,now){
    const missing=[...new Set(ids.filter(Boolean))].filter(id=>!(catalog.get(id)?.until>now));
    if(!missing.length)return;
    const params=new URLSearchParams({Ids:missing.join(','),Fields:'Overview,Genres',Limit:String(missing.length)});
    let items=[];
    try{items=(await json(target+'Items?'+params,headers)).Items??[];}catch{}
    for(const id of missing){
      const item=items.find(i=>String(i.Id)===String(id));
      catalog.set(id,{until:now+(item?3600000:60000),item:item?media(item):catalog.get(id)?.item});
    }
    for(const [k,v] of catalog)if(v.until<now)catalog.delete(k);
  }
  let nextWeekly=0,loadingWeekly=false;
  async function refreshWeekly(now){
    let ranked,source;
    try{
      ranked=await reportingRanks(target+'user_usage_stats/submit_custom_query',headers);
      source='Server history';
    }catch{}
    if(!ranked?.length){
      const audience=await viewerRanks(path=>json(target+path,headers),now);
      ranked=audience;source='Emby viewers';
    }
    await lookup(ranked.map(r=>r.id),now);
    const entries=await Promise.all(ranked.map(async r=>({
      id:r.id,title:r.name,seconds:r.seconds,viewers:r.viewers,poster:await image(catalog.get(r.id)?.item?.posterRequest)
    })));
    sections.weekly={at:now,value:{entries,source}};
  }
  while(true) {
    const now=Date.now();
    if(key && !loadingWeekly && now>=nextWeekly){
      nextWeekly=now+900000;loadingWeekly=true;
      refreshWeekly(now).catch(()=>{sections.weekly={at:now,error:'Server playback history unavailable'};nextWeekly=now+300000;}).finally(()=>{loadingWeekly=false;});
    }
    const pending=Object.entries(sources[kind]).filter(([id])=>!(due[id]>now));
    await Promise.all(pending.map(async ([id,[path,interval,normalize]])=>{
      due[id]=now+interval*1000;
      try {
        if(kind==='emby' && !key) throw Error('API key needed');
        const r=await fetch(target+path,{headers,redirect:'error',signal:AbortSignal.timeout(4500)});
        if(!r.ok) throw Error([401,403].includes(r.status)?'Access denied':'HTTP '+r.status);
        const value=normalize(await r.json());
        if(id==='info' && value.HasUpdateAvailable){
          const key=JSON.stringify(value);
          if(key!==releaseKey || now>=releaseUntil){
            release=await updateDetails(value,path=>json(target+path,headers),url=>json(url,{'User-Agent':'Emby-Zurface-Widget'}));
            releaseKey=key;releaseUntil=now+(release.notes?3600000:300000);
          }
          value.release=release;
        }else if(id==='info')releaseKey='';
        if(id==='sessions'){
          await lookup(value.map(r=>r.itemId),now);
          for(const row of value){
            const item=catalog.get(row.itemId)?.item;
            if(item)for(const field of ['overview','community','critic','genres','rating'])row[field]??=item[field];
          }
          const active=value.filter(s=>s.title&&!s.paused);
          const total=active.reduce((n,s)=>n+(s.bitrate||0),0);
          rates.push({at:now,value:total,known:active.every(s=>s.bitrate>0)});
          while(rates[0]?.at<now-300000)rates.shift();
        }
        if(id==='sessions' || id==='recent') {
          for(let i=0;i<value.length;i+=4) await Promise.all(value.slice(i,i+4).map(async row=>{
            if(id==='recent' && row!==value[0]){delete row.posterRequest;delete row.backdropRequest;return;}
            [row.poster,row.avatar,row.backdrop]=await Promise.all([image(row.posterRequest),image(row.avatarRequest),image(row.backdropRequest)]);
            delete row.posterRequest; delete row.avatarRequest; delete row.backdropRequest;
          }));
        }
        sections[id]={at:Date.now(),value};
      } catch(e) {
        sections[id]={...sections[id],error:e.message==='fetch failed'?'Server unreachable':e.message};
        due[id]=now+Math.min(interval,30)*1000;
      }
    }));
    if(pending.length) await publish(kind,{kind,at:Date.now(),sections,rates});
    if(now>cleanupAt) {
      cleanupAt=now+3600000;
      for(const file of await readdir(dir)) {
        if(!/^[a-f0-9]{32}\.jpg$/.test(file)) continue;
        const path=join(dir,file);
        if(now-(await stat(path)).mtimeMs>172800000) await unlink(path);
      }
    }
    await delay(Math.max(250,Math.min(...Object.values(due))-Date.now()));
  }
}
await run('emby');
