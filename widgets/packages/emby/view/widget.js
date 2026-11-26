(() => {
  const wall=document.querySelector('#wall'), expanded=document.querySelector('#expanded');
  const back=document.querySelector('#back'), status=document.querySelector('#status');
  let sample, selected, signature, pending=false, rememberedLeft=0;
  const el=(tag,text='',cls='')=>Object.assign(document.createElement(tag),{textContent:text,className:cls});
  const section=k=>sample?.sections?.[k];
  const value=k=>section(k)?.value;
  const art=path=>/^art\/[0-9a-f]{32}\.jpg$/.test(path||'')?path:null;
  const sessionId=s=>s.id || [s.user,s.device,s.client].join('/');
  const label=s=>s.series || s.title;
  const join=items=>items.filter(Boolean).join('  ·  ');
  function clock(ticks){
    const sec=Math.max(0,Math.floor(ticks/1e7));
    return (sec>=3600?Math.floor(sec/3600)+':':'')+String(Math.floor(sec/60)%60).padStart(sec>=3600?2:1,'0')+':'+String(sec%60).padStart(2,'0');
  }
  function picture(path,text,cls){
    const box=el('div','',cls);
    box.append(el('span',text));
    if(art(path)){
      const img=new Image(); img.alt=''; img.src=path; img.onerror=()=>img.remove(); box.append(img);
    }
    return box;
  }
  function identity(s){
    const wrap=el('div','','identity'), copy=el('div');
    copy.append(el('b',s.user),el('small',join([s.client,s.device!==s.client && s.device])));
    wrap.append(picture(s.avatar,Array.from(s.user||'?')[0].toUpperCase(),'avatar'),copy);
    return wrap;
  }
  function progress(s){
    if(!(s.duration>0 && Number.isFinite(s.position))) return el('div');
    const pos=Math.min(s.duration,Math.max(0,s.position)), pct=pos/s.duration;
    const box=el('div','','timeline'),line=el('div','','track'),fill=el('i');
    fill.style.width=pct*100+'%'; line.append(fill);
    box.append(line,el('small',clock(pos)+' / '+clock(s.duration)));
    return box;
  }
  function hero(s,live){
    const box=el('article','','hero');
    if(!s){
      const text=el('div','','details');
      text.append(el('small','NOW PLAYING','eyebrow'),el('h1',section('sessions')?.error || (value('sessions')?'The screen is yours.':'Waiting for Emby')),el('p',value('sessions')?'No active streams on '+serverName()+'.':'Waiting for the capture service.'));
      box.append(text);return box;
    }
    if(art(s.backdrop || s.poster))box.style.setProperty('--still','url("'+(art(s.backdrop)||art(s.poster))+'")');
    const details=el('div','','details');
    details.append(el('small',live?(s.paused?'Ⅱ   PAUSED':'▶   NOW PLAYING'):'RECENTLY ADDED','eyebrow'),el('h1',label(s)));
    const episode=s.series?join([s.season!=null && s.episode!=null?'S'+s.season+' E'+s.episode:'',s.title]):'';
    const meta=join([episode || s.type,s.year,s.rating]);
    if(meta) details.append(el('p',meta,'meta'));
    if(live){
      details.append(identity(s),progress(s));
      const format=join([s.method?.replace(/([a-z])([A-Z])/g,'$1 $2'),s.bitrate>0?(s.bitrate/1e6).toFixed(1)+' Mbps':'']);
      if(format)details.append(el('small',format,'format'));
    }else details.append(el('small',value('sessions')&&!section('sessions').error?'No active streams':'Session data unavailable','format'));
    box.append(picture(s.poster,(label(s)||'').slice(0,1),'poster'),details); return box;
  }
  const method=s=>s.method?.replace(/([a-z])([A-Z])/g,'$1 $2');
  function posterCard(s){
    const card=el('article','','card');
    card.dataset.id=sessionId(s);
    const hit=el('button','','poster-hit');
    hit.type='button';hit.dataset.id=sessionId(s);
    hit.setAttribute('aria-label','Playback details for '+s.user+' watching '+label(s));
    if(art(s.backdrop))card.style.setProperty('--still','url("'+s.backdrop+'")');
    const copy=el('div','','card-copy'), state=el('small',s.paused?'Ⅱ  PAUSED':'▶  PLAYING','eyebrow');
    const feature=el('div','','film'), playback=el('div','','playback');
    copy.append(state,el('h2',label(s)),el('small',s.series?s.title:join([s.year,s.type]),'subtitle'));
    feature.append(picture(s.poster,(label(s)||'?')[0],'sleeve'),copy);
    playback.append(identity(s),progress(s));
    card.dataset.paused=String(!!s.paused);
    card.append(feature,playback,hit);
    card.onclick=()=>{rememberedLeft=wall.scrollLeft;selected=sessionId(s);draw(true);resetDetailTimer();back.focus({preventScroll:true});};
    return card;
  }
  function details(s){
    document.querySelector('#feature').replaceChildren(hero(s,true));
    const tracks=document.querySelector('#tracks');
    const rows=[
      ['Device',s.device,join([s.client,s.clientVersion])],
      ['Stream',join([s.container?.toUpperCase(),s.bitrate>0 && (s.bitrate/1e6).toLocaleString(undefined,{maximumFractionDigits:1})+' Mbps']),method(s)],
      ['Video',s.video,s.videoMode],['Audio',s.audio,s.audioMode]
    ];
    const top=tracks.dataset.item===String(s.itemId||s.title)?tracks.scrollTop:0;
    tracks.dataset.item=String(s.itemId||s.title);
    const story=el('section','','story');
    const badges=el('div','','scores');
    if(Number.isFinite(s.critic))badges.append(el('b','Critics '+s.critic+'%'));
    if(Number.isFinite(s.community))badges.append(el('b','★ '+s.community.toFixed(1)+' / 10'));
    if(s.genres?.length)badges.append(el('small',s.genres.slice(0,3).join(' · ')));
    if(badges.childNodes.length)story.append(badges);
    if(s.overview)story.append(el('p',s.overview));
    tracks.replaceChildren(...(story.childNodes.length?[story]:[]),...rows.filter(([,text,note])=>text||note).map(([name,text,note])=>{
      const row=el('div'); row.append(el('small',name,'key'),el('strong',text||note));
      if(text&&note)row.append(el('small',note,'route'));return row;
    }));
    tracks.scrollTop=top;
  }
  function close(){
    const id=selected; selected=undefined; draw(true);
    [...wall.querySelectorAll('.card')].find(c=>c.dataset.id===id)?.querySelector('.poster-hit')?.focus({preventScroll:true});
  }
  let advanceTimer, detailTimer, touchingWall=false;
  const arrows=document.querySelector('#wall-controls');
  let targetLeft;
  function stepWall(direction){
    const max=Math.max(0,wall.scrollWidth-wall.clientWidth);
    const at=Math.min(max,targetLeft??wall.scrollLeft);
    const offsets=[...new Set([0,...[...wall.children].map(card=>Math.min(max,card.offsetLeft)),max])];
    const next=direction>0?offsets.find(x=>x>at+2):offsets.reverse().find(x=>x<at-2);
    const reduced=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    targetLeft=next??(direction>0?0:max);
    wall.scrollTo({left:targetLeft,behavior:reduced?'instant':'smooth'});
  }
  for(const button of arrows.querySelectorAll('button')){
    button.onclick=()=>{
      clearTimeout(advanceTimer);advanceTimer=undefined;
      stepWall(Number(button.dataset.step));syncAdvance();
    };
  }
  function syncAdvance(){
    arrows.hidden=wall.hidden||!wall.classList.contains('carousel');
    if(wall.hidden || !wall.classList.contains('carousel') || document.hidden || dialog.open || touchingWall){
      clearTimeout(advanceTimer);advanceTimer=undefined;return;
    }
    if(advanceTimer!==undefined)return;
    advanceTimer=setTimeout(()=>{
      advanceTimer=undefined;
      stepWall(1);
      syncAdvance();
    },5000);
  }
  function resetDetailTimer(){
    clearTimeout(detailTimer);
    if(selected && !document.hidden && !dialog.open)detailTimer=setTimeout(close,15000);
  }
  for(const event of ['wheel','keydown','touchstart'])wall.addEventListener(event,()=>{targetLeft=undefined;},{passive:true});
  wall.addEventListener('scroll',()=>{if(Math.abs(wall.scrollLeft-targetLeft)<1)targetLeft=undefined;},{passive:true});
  wall.addEventListener('pointerdown',()=>{targetLeft=undefined;touchingWall=true;syncAdvance();});
  function releaseWall(){if(touchingWall){touchingWall=false;syncAdvance();}}
  window.addEventListener('pointerup',releaseWall);
  window.addEventListener('pointercancel',releaseWall);
  for(const event of ['pointerdown','pointerup','touchmove','wheel','keydown','click']){
    expanded.addEventListener(event,resetDetailTimer,{passive:true});
  }
  document.addEventListener('visibilitychange',()=>{syncAdvance();resetDetailTimer();});
  back.onclick=close;
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&selected&&!dialog.open)close();});
  const update=document.querySelector('#update'), dialog=document.querySelector('#release');
  const notes=document.querySelector('#notes'), dismiss=document.querySelector('#dismiss');
  let displayed;
  const noteTags=new Set('p div span h1 h2 h3 h4 h5 h6 ul ol li strong b em i del s blockquote pre code br hr table thead tbody tr th td a'.split(' '));
  function renderRelease(raw){
    const parsed=document.createElement('template');
    parsed.innerHTML=marked.parse(raw.replace(/^\uFEFF/,''),{gfm:true});
    function append(parent,node){
      if(node.nodeType===Node.TEXT_NODE){parent.append(node.textContent);return;}
      const tag=node.localName;
      if(!tag || ['script','style','template','svg','math','iframe','object'].includes(tag))return;
      if(tag==='img'){parent.append(node.getAttribute('alt')||'');return;}
      if(tag==='input' && node.getAttribute('type')==='checkbox'){parent.append(node.hasAttribute('checked')?'☑ ':'☐ ');return;}
      let dest=parent;
      if(noteTags.has(tag)){
        dest=document.createElement(tag);
        if(tag==='ol' && /^-?\d+$/.test(node.getAttribute('start')))dest.start=Number(node.getAttribute('start'));
        if(tag==='a'){
          try {
            const url=new URL(node.getAttribute('href'));
            if(['https:','http:'].includes(url.protocol)){
              dest.href=url.href;dest.target='_blank';dest.rel='noopener noreferrer';
            }
          }catch{}
        }
        parent.append(dest);
      }
      for(const child of node.childNodes)append(dest,child);
    }
    const result=document.createDocumentFragment();
    for(const node of parsed.content.childNodes)append(result,node);
    return result;
  }
  function renderNotes(){
    const info=value('info')||{}, release=info.release||{};
    document.querySelector('#release-title').textContent=release.version?'Version '+release.version:'Update available';
    const raw=release.notes?.trim()||'Release notes are unavailable for this update.';
    const key=JSON.stringify([release.version,raw]);
    if(key===displayed)return;
    try{notes.replaceChildren(renderRelease(raw));}catch{notes.textContent=raw;}
    displayed=key;notes.scrollTop=0;
  }
  update.onclick=()=>{renderNotes();dialog.showModal();syncAdvance();resetDetailTimer();dismiss.focus();};
  dismiss.onclick=()=>dialog.close();
  dialog.onclose=()=>{syncAdvance();resetDetailTimer();if(!update.hidden)update.focus({preventScroll:true});};
  const additions=document.querySelector('#additions'),strip=additions.querySelector('.ticker-track');
  let tickerKey;
  function ticker(recent){
    const titles=recent.map(r=>r.title).filter(Boolean);
    const key=JSON.stringify(titles);
    if(key===tickerKey)return;
    tickerKey=key; additions.hidden=!titles.length;
    const group=el('span','','ticker-group');
    for(const title of titles)group.append(el('span',title));
    strip.replaceChildren(group);
    if(titles.length>1){
      const duplicate=group.cloneNode(true);duplicate.setAttribute('aria-hidden','true');strip.append(duplicate);
    }
    strip.style.setProperty('--crawl',Math.max(28,titles.join('').length*.62)+'s');
  }
  const weekly=document.querySelector('#weekly');
  let weeklyId, weeklyStamp, rotateAt=0;
  function showWeekly(advance=false){
    const {entries=[],source}=value('weekly')||{};
    weekly.hidden=!entries.length || !['Server history','Emby viewers'].includes(source);
    if(weekly.hidden)return;
    let index=Math.max(0,entries.findIndex(e=>e.id===weeklyId));
    if(advance)index=(index+1)%entries.length;
    const entry=entries[index];
    weeklyId=entry.id;
    const minutes=Math.floor(entry.seconds/60);
    const duration=minutes>=60?Math.floor(minutes/60)+'h '+minutes%60+'m':minutes?minutes+' min':'<1 min';
    const measure=source==='Emby viewers'?entry.viewers+' '+(entry.viewers===1?'viewer':'viewers'):duration+' watched';
    const stamp=JSON.stringify([entry.id,entry.title,entry.poster,measure,index,entries.length,source]);
    if(stamp===weeklyStamp)return;
    weeklyStamp=stamp;
    weekly.setAttribute('aria-label','Most watched, rank '+(index+1)+': '+entry.title+(entries.length>1?'. Tap for next title.':''));
    const copy=el('div','','rank-copy');
    copy.append(el('small',source==='Emby viewers'?'MOST VIEWERS · 7 DAYS':'MOST WATCHED · 7 DAYS'),el('strong',entry.title),el('small',measure+' · Emby'));
    const rank=el('span','#'+(index+1),'rank');
    weekly.replaceChildren(picture(entry.poster,'♫','week-art'),copy,rank);
  }
  weekly.onclick=()=>{showWeekly(true);rotateAt=Date.now()+15000;};
  function renderRail(info,playing){
    const active=playing.filter(s=>!s.paused), trans=active.filter(s=>/transcod/i.test(s.method));
    const total=active.reduce((n,s)=>n+(s.bitrate||0),0);
    const known=active.filter(s=>s.bitrate>0).length;
    document.querySelector('#rate').textContent=!value('sessions')||(!known&&active.length)?'—':
      (total/1e6).toLocaleString(undefined,{maximumFractionDigits:1})+(known<active.length?'+':'')+' Mbps';
    const modes=new Map();
    const labels={DirectPlay:'direct play',DirectStream:'direct stream',Remux:'remux',Transcode:'transcode'};
    for(const session of playing){
      const name=labels[session.method] || 'unclassified';
      modes.set(name,(modes.get(name)||0)+1);
    }
    const counts=[...modes].map(([name,count])=>count+' '+name);
    if(active.length<playing.length) counts.push((playing.length-active.length)+' paused');
    document.querySelector('#mix').textContent=join(counts);
    const rates=sample?.rates||[], max=Math.max(1,...rates.map(r=>r.value)),end=rates.at(-1)?.at;
    let path='', previous=0;
    for(const r of rates){
      if(!r.known){previous=0;continue;}
      path+=(previous&&r.at-previous<20000?'L':'M')+(180*(1-(end-r.at)/300000)).toFixed(1)+' '+(21-20*r.value/max).toFixed(1)+' ';
      previous=r.at;
    }
    document.querySelector('#trend path').setAttribute('d',path);
    const task=value('tasks')?.[0],event=value('event')?.[0];
    const work=document.querySelector('#work');
    work.replaceChildren(el('small',task?'Running task':trans.length?'Transcoding':event?'Last event':'Server activity'),
      el('b',task?join([task.name,Number.isFinite(task.progress)&&Math.round(task.progress)+'%']):trans.length?label(trans[0]):event?.name||'No recent activity'));
    update.hidden=!info.HasUpdateAvailable;
    update.textContent=info.release?.version?'Update · '+info.release.version+' ›':'Update available ›';
    if(dialog.open){if(update.hidden)dialog.close();else renderNotes();}
  }
  // The connection's name, else the name Emby reports, else the address's host.
  function serverName(){return window.Dashledge?.displayName(value('info')?.ServerName)||value('info')?.ServerName||'your server'}
  function draw(force=false){
    const stale=sample && Date.now()-sample.at>25000;
    const next=[selected,sample?.at,stale].join('|');
    if(!force && signature===next)return;
    signature=next;
    const sessions=value('sessions')||[], playing=sessions.filter(s=>s.title), idle=sessions.filter(s=>!s.title);
    const info=value('info')||{}, counts=value('counts')||{};
    renderRail(info,playing);showWeekly();ticker(value('recent')||[]);
    const current=playing.find(s=>sessionId(s)===selected);
    const errors=Object.entries(sample?.sections||{}).filter(([,s])=>s.error);
    status.textContent=!sample?'Connecting':stale?'Last reading':errors.length?errors[0][0]+' · '+errors[0][1].error:'Live';
    status.dataset.live=String(!!sample&&!stale&&!errors.length);
    document.querySelector('#summary').textContent=playing.length?playing.length+' '+(playing.length===1?'stream':'streams'):'';
    document.querySelector('#host').textContent=join([serverName(),info.Version,info.HasPendingRestart&&'Restart pending']);
    document.title='Emby · '+serverName();
    document.querySelector('#viewers').textContent=idle.length?'Recently connected  ·  '+[...new Set(idle.map(s=>s.user))].join(', '):'';
    document.querySelector('#library').textContent=join(Object.entries({MovieCount:'movies',SeriesCount:'series',EpisodeCount:'episodes',SongCount:'tracks'}).filter(([key])=>counts[key]>0).map(([key,name])=>counts[key].toLocaleString()+' '+name));
    if(current){
      expanded.hidden=false;wall.hidden=true;syncAdvance();details(current);return;
    }
    const restoring=wall.hidden;
    selected=undefined;expanded.hidden=true;wall.hidden=false;
    clearTimeout(detailTimer);
    wall.classList.toggle('carousel',playing.length>3);
    const focusId=document.activeElement?.dataset.id;
    wall.classList.toggle('idle',!playing.length);
    wall.style.setProperty('--sessions',Math.max(1,playing.length));
    if(playing.length){
      const old=new Map([...wall.querySelectorAll('.card')].map(card=>[card.dataset.id,card]));
      for(const node of [...wall.children])if(!node.classList.contains('card'))node.remove();
      playing.forEach((s,index)=>{
        const id=sessionId(s), card=old.get(id), stamp=JSON.stringify(s);
        let next=card;
        if(!card || card.sessionStamp!==stamp){
          next=posterCard(s);next.sessionStamp=stamp;
          if(card){
            card.dataset.paused=next.dataset.paused;card.style.cssText=next.style.cssText;
            card.replaceChildren(...Array.from(next.children));card.sessionStamp=stamp;next=card;
          }
        }
        if(wall.children[index]!==next)wall.insertBefore(next,wall.children[index]||null);
        old.delete(id);
      });
      for(const card of old.values())card.remove();
    }else wall.replaceChildren(hero(value('recent')?.[0],false));
    if(restoring)wall.scrollLeft=rememberedLeft;
    syncAdvance();
    if(focusId)[...wall.children].find(c=>c.dataset.id===focusId)?.querySelector('.poster-hit')?.focus({preventScroll:true});
  }
  window.serverSnapshot=s=>{if(s?.kind==='emby'){sample=s;draw();}};
  window.Dashledge?.subscribe(()=>{if(sample)draw(true)});
  function refresh(){
    if(document.hidden||pending)return;
    if(!dialog.open && !selected && Date.now()>=rotateAt && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches){
      showWeekly(rotateAt!==0);rotateAt=Date.now()+10000;
    }
    draw();pending=true;
    const script=document.createElement('script');
    const done=()=>{clearTimeout(timeout);script.remove();pending=false;};
    const timeout=setTimeout(done,4500);
    script.onload=script.onerror=done;script.src='snapshot.js?t='+Date.now();document.head.append(script);
  }
  refresh();setInterval(refresh,5000);document.addEventListener('visibilitychange',refresh);
})();
