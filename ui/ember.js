import {el,button,invoke} from './common.js';

function tokens(parent,items){
  for(const t of items||[]){
    if(t.type==='space')continue;
    if(t.type==='br'){parent.append(el('br'));continue}
    if(t.type==='list'){
      const list=el(t.ordered?'ol':'ul');for(const item of t.items){const row=el('li');tokens(row,item.tokens);list.append(row)}parent.append(list);continue;
    }
    const tag={heading:'h3',paragraph:'p',strong:'strong',em:'em',del:'s',code:'pre',codespan:'code',blockquote:'blockquote',link:'span'}[t.type];
    const node=tag?el(tag):document.createDocumentFragment();
    if(t.tokens)tokens(node,t.tokens);else node.append(document.createTextNode(t.text??t.raw??''));
    parent.append(node);
  }
}
function bubble(item){
  if(['thinking','tool','result'].includes(item.kind)){
    const d=el('details','tool');d.append(el('summary','',({thinking:'◌ ',tool:'⌘ ',result:'↳ '})[item.kind]+item.label),el('pre','',item.text));return d;
  }
  const box=el('section','utterance '+item.kind);
  box.append(el('small','',item.kind==='user'?'You':'Ember'));
  try{tokens(box,window.marked.lexer(item.text))}catch{box.append(el('p','',item.text))}
  return box;
}
export function emberTile(tile){
  if(tile.ember){tile.ember.poll();return tile.ember.root}
  const root=el('div','ember-session'),chats=el('div','chat-rail'),pane=el('div','transcript'),wrap=el('div','transcript-wrap');
  const follow=button('↓',()=>{live=true;pane.scrollTop=pane.scrollHeight;follow.hidden=true},'live-follow');
  follow.setAttribute('aria-label','Return to live');follow.hidden=true;wrap.append(pane,follow);root.append(chats,wrap);
  let active,live=true,busy=false,nextChats=0,nextRead=0,last='',generation=0;
  pane.onscroll=()=>{live=pane.scrollHeight-pane.clientHeight-pane.scrollTop<36;follow.hidden=live};
  function select(chat){generation++;active=chat;last='';live=true;follow.hidden=true;pane.replaceChildren();nextRead=0;
    for(const b of chats.children)b.classList.toggle('selected',b.dataset.id===chat.id);poll()}
  async function poll(){
    if(busy||document.hidden)return;
    busy=true;
    try{
      if(Date.now()>=nextChats){
        nextChats=Date.now()+4000;const rows=await invoke('ember_chats');
        chats.replaceChildren(...rows.map(r=>{const b=button(r.title||'Untitled chat',()=>select(r),r.id===active?.id?'selected':'');b.dataset.id=r.id;return b}));
        if(!active||!rows.some(r=>r.id===active.id)){active=rows[0];last='';live=true;nextRead=0;pane.textContent=active?'':'No recent chats'}
      }
      if(active&&Date.now()>=nextRead){
        const token=generation;nextRead=Date.now()+1200;
        const rows=await invoke('ember_transcript',{chat:active.id,folders:[active.cwd,active.worktree,active.workspace].filter(Boolean)});
        if(generation!==token)return;
        const sig=JSON.stringify(rows);if(sig===last)return;
        const open=new Set([...pane.children].map((n,i)=>n.open?i:-1));const prior=pane.scrollTop;last=sig;
        pane.replaceChildren(...rows.map((r,i)=>{const n=bubble(r);if(open.has(i)&&n.tagName==='DETAILS')n.open=true;return n}));
        if(!rows.length)pane.textContent='Waiting for chat activity';
        pane.scrollTop=live?pane.scrollHeight:prior;
      }
    }catch(e){if(!last)pane.textContent=String(e)}finally{busy=false}
  }
  tile.ember={root,poll};poll();return root;
}
