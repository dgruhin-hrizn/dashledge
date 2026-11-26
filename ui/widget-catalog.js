import {titles, slot} from './model.js';

import {slackWidgets} from './slack-catalog.js';
export const categories = {
  'Music & media': ['spotify','applemusic','photos'],
  'Productivity': ['googledesk','shortcuts','notes','focus'],
  'Clocks': ['clock','world','rundmd'],
  'Finance': ['markets'],
  'Slack': Object.keys(slackWidgets),
  'Mac system': ['cpu','gpu','memory','disk','network','power','interfaces','volumes','machine'],
  'Servers & storage': [],
  'AI & development': ['plans'],
};
export function catalogGroups(config){
  return [...Object.entries(categories),['Installed packages',config.plugins.map(p=>p.id)]]
    .map(([name,kinds])=>[name,kinds.filter(kind=>installed(config,kind))])
    .filter(([,kinds])=>kinds.length);
}
const descriptions = {
  plans:'Claude and Codex subscription limits, remaining allowance and local reset times.',
  markets:'Live US stock and ETF trades, watchlists and intraday charts via Alpaca IEX.',
  photos:'A moving gallery from your Mac Photos library and albums.',
  shortcuts:"Run your pinned Mac shortcuts from the touch display.",
  rundmd:'A pinball dot-matrix clock with animations from your Run-DMD card.',
  cpu:'Processor load and activity across individual cores.', gpu:'Graphics utilization and recent activity.',
  memory:'Memory allocation, available capacity and swap usage.', disk:'Capacity and free space on a selected volume.',
  network:'Live receive and transmit rates.', power:'Battery charge, power source and thermal state.',
  interfaces:'Network traffic by interface.', volumes:'Free space across mounted volumes.', machine:'Mac hardware, operating system and uptime.',
  clock:'Local time and date.', world:'Local time alongside four world cities.', focus:'A countdown timer for focus sessions.',
  googledesk:'Your Mac agenda, meeting links, and Apple Mail or Spark Desktop.', notes:'A scratchpad shared across your pages.', applemusic:'Control Music on this Mac, browse playlists and visualize playback.', spotify:'Album artwork, touch playback controls and your upcoming Spotify queue.',
};
const versions = {};
// Add a bundled package to its catalog category with its description and version.
export function registerCatalog(info){
  const list=categories[info.category]??=[];
  if(!list.includes(info.id))list.push(info.id);
  if(info.description)descriptions[info.id]=info.description;
  versions[info.id]=info.version||'';
}
export function widgetInfo(config,kind){
  const custom=config.plugins.find(p=>p.id===kind);
  if(custom)return {...custom,kind,category:'Installed packages',icon:custom.iconData};
  const category=Object.keys(categories).find(k=>categories[k].includes(kind));
  if(!category)return null;
  return {kind,title:titles[kind],description:slackWidgets[kind]?.description||descriptions[kind],category,version:versions[kind],
    icon:slackWidgets[kind]?'widget-icons/slack.svg':Object.hasOwn(versions,kind)?'/widget-icon/'+kind:'widget-icons/'+kind+'.svg',feed:kind};
}
export function installed(config,kind){
  return Object.hasOwn(titles,kind)?kind!=='empty'&&!config.removedWidgets?.includes(kind):config.plugins.some(p=>p.id===kind);
}
export function connectionsFor(config,kind){
  const feed=widgetInfo(config,kind)?.feed;
  return config.sources.filter(s=>{
    if(s.kind!==feed)return false;
    if(feed!=='json')return true;
    if(s.owner)return s.owner===kind;
    return s.widgets?.includes(kind)||config.widgetDefaults?.[kind]===s.id||
      config.pages.some(p=>p.slots.some(slot=>slot.kind===kind&&slot.source===s.id));
  });
}
export function defaultSource(config,kind){
  const sources=connectionsFor(config,kind);
  return (sources.find(s=>s.id===config.widgetDefaults?.[kind])||sources[0])?.id||'';
}
export function useDefault(config,kind,source){
  const old=defaultSource(config,kind);
  (config.widgetDefaults??={})[kind]=source;
  for(const p of config.pages)for(const s of p.slots){
    if(s.kind===kind&&(!s.source||s.source===old))s.source=source;
  }
}
export function placements(config,kind){
  return config.pages.flatMap(page=>page.slots.flatMap((s,index)=>s.kind===kind?[{page,index}]:[]));
}
// Record an installed API version 2 package in the layout. Its files live on disk;
// the layout keeps what the catalog shows. Updating keeps existing placements.
export function packageEntry(info){
  const entry={apiVersion:2,id:info.id,title:info.title,tier:info.tier};
  for(const key of ['description','version','category','iconData'])if(info[key])entry[key]=info[key];
  if(info.sources?.max){
    entry.feed=info.id;
    entry.sources={min:info.sources.min,max:info.sources.max};
    for(const key of ['addressLabel','addressPlaceholder','credentialLabel'])if(info.sources[key])entry.sources[key]=info.sources[key];
  }
  if(info.view?.viewport==='native')entry.viewport='native';
  if(info.actions?.length)entry.actions=info.actions.map(a=>a.id);
  if(info.displayName?.serverField)entry.serverField=info.displayName.serverField;
  return entry;
}
export function recordPackage(config,info){
  const entry=packageEntry(info),i=config.plugins.findIndex(p=>p.id===entry.id),old=config.plugins[i];
  if(old)config.plugins[i]=entry;else config.plugins.push(entry);
  if(old&&old.apiVersion!==2)for(const {page,index} of placements(config,entry.id))page.slots[index].source='';
  return !old;
}
export function removeWidget(config,kind){
  for(const {page,index} of placements(config,kind))page.slots[index]={...slot(),id:page.slots[index].id};
  if(Object.hasOwn(titles,kind))config.removedWidgets=[...new Set([...(config.removedWidgets||[]),kind])];
  else config.plugins=config.plugins.filter(p=>p.id!==kind);
}
