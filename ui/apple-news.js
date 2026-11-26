import {button, el, field, invoke, select} from './common.js';
import {openTouchKeyboard} from './search-keyboard.js';

const editions = {bbc:'BBC News', technology:'BBC Technology', guardian:'The Guardian · World', pinned:'My Apple News links'};
const cache = new Map();
const refreshMs = 10 * 60 * 1000;

export function storyLink(value, pinned = false) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return '';
    if (url.hostname === 'apple.news' && /^\/[AT][\w-]+\/?$/.test(url.pathname)) return url.href;
    if (!pinned && /(^|\.)(bbc\.co\.uk|bbc\.com|theguardian\.com)$/.test(url.hostname)) return url.href;
  } catch {}
  return '';
}

export function parseFeed(xml) {
  const doc = new DOMParser().parseFromString(xml,'application/xml');
  if (doc.documentElement.localName !== 'rss') throw Error('The publisher returned an unreadable feed.');
  const rows = [], seen = new Set();
  for (const item of doc.querySelectorAll('channel > item')) {
    const title = item.querySelector('title')?.textContent.trim();
    const url = storyLink(item.querySelector('link')?.textContent.trim());
    if (!title || !url || seen.has(url)) continue;
    const artwork = Array.from(item.getElementsByTagNameNS('http://search.yahoo.com/mrss/','thumbnail'))
      .at(-1)?.getAttribute('url') || '';
    rows.push({title,url,artwork:/^https:\/\//.test(artwork) ? artwork : ''});
    seen.add(url);
    if (rows.length === 30) break;
  }
  return rows;
}

async function headlines(source) {
  const entry = cache.get(source) || {};
  cache.set(source,entry);
  if (Date.now() - entry.at < refreshMs) return entry.rows;
  entry.pending ??= invoke('news_headlines',{source}).then(xml => {
    entry.rows = parseFeed(xml);
    entry.at = Date.now();
    return entry.rows;
  }).finally(() => {delete entry.pending});
  return entry.pending;
}

export function editNews(settings,save,{title='Edit news edition',touch=false}={}) {
  let source = settings?.source || 'bbc';
  const pins = [...(settings?.pins || [])];
  const dlg = el('dialog','news-settings'), list = el('section'), error = el('p');
  dlg.setAttribute('aria-label',title);
  error.setAttribute('role','alert');
  const titleInput = el('input'), urlInput = el('input');
  for (const [input,label] of [[titleInput,'Story, channel, or topic name'],[urlInput,'Apple News share link']]) {
    input.placeholder=label;
    input.setAttribute('aria-label',label);
    if (touch) input.onclick=()=>{
      const sheet=openTouchKeyboard({title:label,brand:'Apple News',icon:'widget-icons/applenews.svg',placeholder:label,actionLabel:'Done',onSubmit:()=>{
        input.value=sheet.input.value;sheet.dialog.close();
      }});
      sheet.input.value=input.value;
    };
  }
  function paint() {
    list.replaceChildren();
    if (source !== 'pinned') return;
    for (const pin of pins) {
      const row=el('div','news-pin');
      row.append(el('span','',pin.title),button('Remove',()=>{pins.splice(pins.indexOf(pin),1);paint()}));
      list.append(row);
    }
    list.append(el('p','','In Apple News, Control-click a channel, topic, or story in search results and choose Copy Link.'),titleInput,urlInput,button('Paste link',async()=>{
      try{const pin=await invoke('news_clipboard_link');urlInput.value=pin.url;if(!titleInput.value)titleInput.value=pin.title;error.textContent=''}catch(e){error.textContent=String(e)}
    }),button('Add link',()=>{
      const url=storyLink(urlInput.value.trim(),true), name=titleInput.value.trim();
      if (!url || !name) {error.textContent='Enter a name and an Apple News story, channel, or topic link.';return}
      if (pins.some(pin=>pin.url===url)) {error.textContent='This link is already pinned.';return}
      pins.push({title:name,url});titleInput.value=urlInput.value=error.textContent='';paint();
    }));
  }
  const picker=select(Object.entries(editions),source,value=>{source=value;error.textContent='';paint()});
  const footer=el('footer');
  footer.append(button('Cancel',()=>dlg.close()),button('Save edition',()=>{
    if(source==='pinned' && (titleInput.value.trim() || urlInput.value.trim())) {error.textContent='Add the link before saving.';return}
    try {save({source,pins});dlg.close()} catch(e){error.textContent=String(e)}
  }));
  dlg.append(el('h2','',title),field('Edition for this placement',picker),list,error,footer);
  paint();document.body.append(dlg);dlg.onclose=()=>dlg.remove();dlg.showModal();
}

export function mountNews(box,settings,save) {
  const source=Object.hasOwn(editions,settings?.source)?settings.source:'bbc';
  let rows=source==='pinned'?(settings?.pins || []):cache.get(source)?.rows || [];
  let index=0, disposed=false, busy=false;
  box.classList.add('news-widget');
  const mast=el('header'), brand=el('strong','','News'), actions=el('div'), body=el('div','news-body');
  const lead=el('section','news-lead'), rail=el('aside'), status=el('span','news-status'), footer=el('footer');
  status.setAttribute('role','status');
  const edit=()=>editNews(settings,save,{touch:true});
  async function open(link=null){try{await invoke('news_open',{link})}catch(e){status.textContent=String(e)}}
  const paste=button('Add from clipboard',async()=>{
    paste.disabled=true;paste.textContent='Adding…';
    try{
      const pin=await invoke('news_clipboard_link');
      if(disposed)return;
      const pins=settings?.pins || [];
      save({source:'pinned',pins:[pin,...pins.filter(existing=>existing.url!==pin.url)]});
    }catch(e){if(!disposed)status.textContent=String(e)}
    finally{paste.disabled=false;paste.textContent='Add from clipboard'}
  });
  actions.append(paste,button('Apple News ↗',()=>open()),button('Edit edition',edit));
  mast.append(brand,actions);body.append(lead,rail);
  const prev=button('‹',()=>choose(index-1)),next=button('›',()=>choose(index+1)),position=el('span');
  prev.setAttribute('aria-label','Previous headline');next.setAttribute('aria-label','Next headline');
  const retry=button('Retry',()=>refresh());retry.hidden=true;
  footer.append(status,retry,prev,position,next);box.append(mast,body,footer);
  function choose(i){index=Math.max(0,Math.min(rows.length-1,i));paint()}
  function paint(){
    lead.replaceChildren(el('div','news-source',editions[source]));rail.replaceChildren();
    const story=rows[index];
    if(story){
      if(story.artwork){
        const img=el('img','news-cover');img.alt='';img.onerror=()=>img.remove();img.src=story.artwork;lead.append(img);
      }
      lead.append(el('h2','',story.title),button(source==='pinned'?'Open in News ↗':'Read at publisher ↗',()=>open(story.url)));
      const start=Math.min(index,Math.max(rows.length-4,0));
      rows.slice(start,start+4).forEach((r,n)=>{
        const row=button(r.title,()=>choose(start+n));row.setAttribute('aria-pressed',String(start+n===index));rail.append(row);
      });
    } else if(source==='pinned') lead.append(el('h2','','Your Apple News links'),button('Add a News link',edit));
    prev.disabled=index===0;next.disabled=index+1>=rows.length;
    position.textContent=rows.length?(index+1)+' / '+rows.length:'';
  }
  async function refresh(){
    if(source==='pinned'||busy||disposed||document.hidden||box.closest('[hidden]'))return;
    busy=true;retry.hidden=true;
    if(!rows.length)status.textContent='Loading headlines…';
    try{
      const fresh=await headlines(source);
      if(disposed)return;
      const current=rows[index]?.url;
      rows=fresh;index=Math.max(0,rows.findIndex(r=>r.url===current));
      status.textContent=rows.length?'':'No headlines available.';paint();
    }catch{if(!disposed){status.textContent=rows.length?'Showing earlier headlines.':'Publisher unavailable.';retry.hidden=false}}
    finally{busy=false}
  }
  paint();refresh();
  const observer=new IntersectionObserver(entries=>{if(entries[0].isIntersecting)refresh()});observer.observe(box);
  const timer=setInterval(refresh,refreshMs);
  return ()=>{disposed=true;clearInterval(timer);observer.disconnect()};
}
