import {playlistCover} from './apple-playlist-covers.js';
import {el,button} from './common.js';
import {openTouchKeyboard} from './search-keyboard.js';

import {cachedPlaylists,readPlaylistPage,freshFor} from './apple-playlist-index.js';

const fold=text=>text.normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase();

function tile(p,play){
  const b=button('',()=>play(p),'am-pl-tile');
  const art=el('span','am-pl-art'),name=el('strong','',p.name||'Untitled playlist'),arrow=el('span','am-pl-arrow','▶');
  let hash=0;for(const ch of p.name)hash=(Math.imul(hash,31)+ch.codePointAt(0))>>>0;
  art.style.setProperty('--h',String(hash%360));art.style.setProperty('--angle',(hash%150)+'deg');
  art.dataset.pattern=String(hash%3);art.setAttribute('aria-hidden','true');
  arrow.setAttribute('aria-hidden','true');b.append(art,name,arrow);b.title=p.name;
  return {b,art};
}

export function showMusicPlaylists(request,play){
  const dialog=el('dialog','am-playlists'),head=el('header'),brand=el('div','am-pl-brand','Apple Music'),logo=el('img');
  logo.src='widget-icons/applemusic.svg';logo.alt='';brand.prepend(logo);
  const title=el('h2','','Playlists'),count=el('span','am-pl-count'),heading=el('div','am-pl-heading');
  heading.append(title,count);
  const tools=el('div','am-pl-tools'),search=button('Find playlist',find),reload=button('Refresh',()=>load(true)),close=button('Close',()=>dialog.close());
  tools.append(search,reload,close);head.append(brand,heading,tools);
  const grid=el('div','am-pl-grid'),foot=el('footer'),status=el('span','am-pl-status'),pages=el('div','am-pl-pages');
  status.setAttribute('role','status');const prev=button('‹  Previous',()=>move(-1)),next=button('Next  ›',()=>move(1)),range=el('span');
  prev.setAttribute('aria-label','Previous playlists');next.setAttribute('aria-label','Next playlists');
  pages.append(prev,range,next);foot.append(status,pages);dialog.append(head,grid,foot);document.body.append(dialog);
  dialog.setAttribute('aria-label','Your playlists');dialog.showModal();
  let rows=[],matches=[],query='',page=0,size=1,columns=1,version=0,imagesSince=0,playing=false;
  let index=null,reading=null,searchView=null,visibleKey;
  function filter(){
    const needle=fold(query.trim());matches=needle?rows.filter(p=>fold(p.name).includes(needle)):rows;
    search.textContent=query?'Find · '+query:'Find playlist';draw();
  }
  function find(){
    const k=openTouchKeyboard({title:'Find a playlist',brand:'Apple Music',icon:'widget-icons/applemusic.svg',placeholder:'Playlist name',theme:'apple-music',
      onSubmit:()=>{query=k.input.value.trim();page=0;filter();k.dialog.close();if(query)scan()}});
    k.input.value=query;k.input.select();
    let previewKey;
    function preview(){
      const term=fold(k.input.value.trim());const found=rows.filter(p=>fold(p.name).includes(term));
      const key=JSON.stringify([found.slice(0,8),!found.length&&index?.next!=null]);
      if(previewKey===key)return;previewKey=key;
      k.content.replaceChildren();
      for(const p of found.slice(0,8)){
        k.content.append(button(p.name,()=>{k.dialog.close();choose(p)},'am-pl-match'));
      }
      if(!found.length)k.content.append(el('p','',index?.next!=null?'Searching the library…':'No matching playlists.'));
    }
    searchView={input:k.input,preview};
    k.dialog.addEventListener('close',()=>{searchView=null});
    k.input.addEventListener('input',()=>{preview();if(k.input.value.trim())scan()});preview();if(query)scan();
  }
  async function choose(p){
    if(playing)return;playing=true;status.textContent='Starting '+p.name+'…';
    try{await play(p);if(dialog.open)dialog.close()}
    catch(e){status.textContent=String(e)}finally{playing=false}
  }
  async function move(step){
    const target=page+step;
    if(target<0)return;
    while(step>0&&index?.next!=null&&matches.length<(target+1)*size){
      if(!await fetchPage(false)||!dialog.open)return;
    }
    page=target;draw();
  }
  let scanning=false;
  async function scan(){
    if(scanning)return;scanning=true;
    try{
      while(dialog.open&&(searchView?searchView.input.value.trim():query)&&index?.next!=null){
        if(!await fetchPage(false))break;
        await new Promise(resolve=>setTimeout(resolve,0));
      }
    }finally{scanning=false}
  }
  function draw(){
    const last=Math.max(0,Math.ceil(matches.length/size)-1);
    page=Math.max(0,Math.min(last,page));const start=page*size,slice=matches.slice(start,start+size);
    count.textContent=(index?.next!=null?index.total:rows.length).toLocaleString();prev.disabled=!page;next.disabled=page>=last&&index?.next==null;
    range.textContent=matches.length?(start+1).toLocaleString()+'–'+(start+slice.length).toLocaleString()+' of '+(query||index?.next==null?matches.length:index.total).toLocaleString():'0 playlists';
    const key=JSON.stringify([slice,imagesSince,!slice.length&&index?.next===null,!!query]);
    if(visibleKey===key)return;visibleKey=key;
    const stamp=++version;
    const nodes=slice.map(p=>tile(p,choose));grid.replaceChildren(...nodes.map(n=>n.b));
    if(!nodes.length&&index?.next===null)grid.append(el('p','am-pl-empty',query?'No matching playlists.':'No playlists in your Music library.'));
    const visible=()=>dialog.open&&stamp===version;
    slice.forEach(async(p,i)=>{
      const url=await playlistCover(p,request,imagesSince,visible);
      if(visible()&&url){const img=el('img');img.alt='';img.src=url;nodes[i].art.append(img)}
    });
  }
  function fit(){
    const cols=Math.max(1,Math.min(4,Math.floor((grid.clientWidth+16)/330)));
    const total=cols*Math.max(1,Math.min(3,Math.floor((grid.clientHeight+16)/110)));
    if(total===size&&cols===columns)return;
    const first=page*size;size=total;columns=cols;page=Math.floor(first/size);
    grid.style.setProperty('--cols',cols);draw();
  }
  function apply(latest){
    index=latest;rows=index.rows;filter();searchView?.preview();
  }
  function fetchPage(first){
    if(reading)return reading;
    reload.disabled=true;next.disabled=true;
    status.textContent=first?(index?'Updating library…':'Loading playlists…'):'Loading playlists…';
    reading=readPlaylistPage(request,first?null:index,size).then(latest=>{
      if(dialog.open){apply(latest);status.textContent=''}
      return true;
    }).catch(e=>{if(dialog.open)status.textContent=(index?'Showing saved playlists. ':'')+String(e);return false})
      .finally(()=>{reading=null;reload.disabled=false;next.disabled=!!index&&index.next===null&&page>=Math.ceil(matches.length/size)-1});
    return reading;
  }
  async function load(force){
    if(force){imagesSince=Date.now();page=0}
    const cached=cachedPlaylists();
    if(cached)apply(cached);
    if(force||!cached||Date.now()-cached.at>=freshFor){if(!await fetchPage(true))return}
    // Folder-only ranges may not contain enough playable entries for the first screen.
    while(dialog.open&&index?.next!=null&&rows.length<size)if(!await fetchPage(false))return;
    if(query||searchView?.input.value.trim())scan();
  }
  const resize=new ResizeObserver(fit);resize.observe(grid);
  dialog.onclose=()=>{version++;resize.disconnect();dialog.remove()};
  fit();load(false);
}
