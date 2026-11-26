import {el,button,select,field} from '../common.js';
import {settings,saveSettings,groupOf,labelOf,enabled,importCard,timeText} from './model.js';
import {boardMenu} from './board.js';
import {styles} from './display.js';

const pairs=items=>items.map(i=>Array.isArray(i)?i:[i,i[0].toUpperCase()+i.slice(1)]);
const tabs=['Playback','Animations','Clock','Messages','Display'];
let lastTab='Playback';

export function openMenu(api){
  const dialog=el('dialog','dmd-menu'),heading=el('header'),nav=el('nav'),body=el('section'),footer=el('footer');
  const status=el('span','dmd-status');status.setAttribute('role','status');
  const done=button('Done',()=>dialog.close(),'primary');
  dialog.setAttribute('aria-label','Run-DMD menu');
  let board;
  const switchMode=button('Four-button menu',()=>{
    if(board){board.dispose();board=null;switchMode.textContent='Four-button menu';return}
    board=boardMenu(dialog,{tabs,showTab:name=>{tab=name;render()},controls:()=>body,
      close:()=>dialog.close(),leave:()=>switchMode.click()});
    switchMode.textContent='Touch menu';
  });
  heading.append(el('h2','','Run-DMD'),switchMode,done);dialog.append(heading,nav,body,footer);
  document.body.append(dialog);dialog.onclose=()=>{board?.dispose();dialog.remove();api.closed?.()};
  let card=api.catalog(),tab=lastTab,group='',search='',page=0;
  function choose(name,key,items){
    return field(name,select(pairs(items),String(settings()[key]),value=>saveSettings({[key]:value})));
  }
  function input(name,key,type='text'){
    const n=el('input');n.type=type;n.value=settings()[key];n.maxLength=160;
    n.onchange=()=>saveSettings({[key]:n.value});return field(name,n);
  }
  function rows(...controls){const grid=el('div','dmd-options');grid.append(...controls);return grid}
  function action(label,fn){return button(label,()=>{dialog.close();fn()})}
  function importButton(){
    const b=button(card?'Change card image…':'Open card image…',async()=>{
      b.disabled=true;status.textContent='Reading card image…';
      try{const result=await importCard();if(result){card=result;group='';page=0;api.imported?.(card);render()}status.textContent=''}
      catch(e){status.textContent=String(e)}finally{b.disabled=false}
    });return b;
  }
  function playback(){
    const times=[1,2,3,5,10,15,30,60,300,600].map(n=>[String(n),n<60?n+' seconds':n/60+' min']);
    body.append(rows(choose('Time between clips','interval',[['random20','Random · 1–20 seconds'],['random60','Random · 5–60 seconds'],...times,['0','Continuous animations'],['off','Clock only']]),
      choose('Clock over artwork','overlay',[['auto','Use clip settings'],['front','Always in front'],['back','Behind transparent dots'],['off','Off']]),
      choose('Clip name','names',['hide','before','during','after']),
      choose('Playback speed','speed',[['0.5','½×'],['1','1×'],['1.5','1½×'],['2','2×']]),
      choose('Content filter','filter',[['enabled','Enabled clips only'],['all','Show all clips']]),
      choose('Startup artwork','startup',[['once','At startup'],['5','Every 5 clips'],['10','Every 10 clips'],['50','Every 50 clips'],['off','Off']])));
    const next=action('Play next clip',()=>api.play());next.disabled=!card?.clips.some(c=>settings().filter==='all'||enabled(c,settings()));
    body.append(next);
  }
  function animations(){
    const summary=el('div','dmd-card-summary'),groups=new Map();
    for(const [i,c] of (card?.clips||[]).entries()){const g=groupOf(c.name);if(!groups.has(g))groups.set(g,[]);groups.get(g).push(i)}
    summary.append(el('strong','',card?card.version+' · '+card.clips.length.toLocaleString()+' clips · '+groups.size+' groups':'Choose your Run-DMD card image'),importButton());body.append(summary);
    if(!card)return;
    const query=el('input');query.type='search';query.placeholder='Search groups or clips';query.value=search;query.setAttribute('aria-label',query.placeholder);
    const scope=select([['','All groups'],...[...groups.keys()].map(g=>[g,labelOf(g)])],group,v=>{group=v;page=0;draw()});
    scope.setAttribute('aria-label','Browse animation group');
    const list=el('div','dmd-list'),tools=el('div','dmd-list-tools'),pager=el('div','dmd-pager');
    function set(indices,value){
      const p=settings(),flags={...p.overrides};
      for(const i of indices){const clip=card.clips[i];if(clip.enabled===value)delete flags[clip.name];else flags[clip.name]=value}
      saveSettings({overrides:flags});draw();
    }
    function check(label,indices,p){
      const n=el('input');n.type='checkbox';n.setAttribute('aria-label',label);
      const active=indices.filter(i=>enabled(card.clips[i],p)).length;
      n.checked=active===indices.length;n.indeterminate=active>0&&!n.checked;n.onchange=()=>set(indices,n.checked);
      return n;
    }
    function draw(){
      const p=settings(),find=search.trim().toUpperCase(),matching=s=>labelOf(s).toUpperCase().includes(find)||s.toUpperCase().includes(find);
      const entries=group||find?(group?groups.get(group):card.clips.map((_,i)=>i)).filter(i=>matching(card.clips[i].name)).map(i=>({label:labelOf(card.clips[i].name),indices:[i],clip:i})):
        [...groups].map(([g,indices])=>({label:labelOf(g),g,indices}));
      const indices=entries.flatMap(e=>e.indices),max=Math.max(0,Math.ceil(entries.length/24)-1);
      page=Math.min(page,max);list.replaceChildren();tools.replaceChildren();pager.replaceChildren();
      const scopeName=group?'group':find?'matches':'all';
      tools.append(button('Enable '+scopeName,()=>set(indices,true)),button('Disable '+scopeName,()=>set(indices,false)));
      for(const e of entries.slice(page*24,page*24+24)){
        const line=el('div','dmd-list-row'),checkBox=check(e.label,e.indices,p);
        if(e.g){const open=button(e.label,()=>{group=e.g;scope.value=group;page=0;draw()},'dmd-group');
          line.append(checkBox,open,el('small','',e.indices.filter(i=>enabled(card.clips[i],p)).length+'/'+e.indices.length+' ›'))}
        else line.append(checkBox,el('span','',e.label),action('Preview',()=>api.play(e.clip)));
        list.append(line);
      }
      if(!entries.length)list.append(el('p','','No clips match your search.'));
      if(max){const prev=button('Previous',()=>{page--;draw()}),next=button('Next',()=>{page++;draw()});prev.disabled=!page;next.disabled=page===max;
        pager.append(prev,el('span','',(page+1)+' / '+(max+1)),next)}
      list.scrollTop=0;
    }
    query.oninput=()=>{search=query.value;page=0;draw()};body.append(rows(query,scope),tools,list,pager);draw();
  }
  function clock(){
    const custom=el('input');custom.type='time';
    custom.value=timeText(new Date(Date.now()+(settings().offset||0)),'24');
    custom.onchange=()=>{if(!custom.value)return;const [h,m]=custom.value.split(':').map(Number),target=new Date();target.setHours(h,m,0,0);saveSettings({offset:target.getTime()-Date.now()})};
    body.append(rows(choose('Time format','format',[['24','24 hour'],['24s','24 hour · seconds'],['12','12 hour'],['12ap','12 hour · AM/PM'],['12s','12 hour · seconds']]),
      choose('Clock face','style',styles),choose('Separator','dots',[['blink','Blink'],['on','Steady'],['off','Hidden']]),
      choose('Clock shade','shade',Array.from({length:16},(_,i)=>[String(i),String(i)])),
      choose('Clock transition','transition',[['random','Random'],['up-up','Up / up'],['down-down','Down / down'],['up-down','Up / down'],['down-up','Down / up'],['fade','Fade'],['none','None']]),
      field('Set clock time',custom)),button('Use Mac time',()=>{saveSettings({offset:0});render()}));
  }
  function messages(){
    const text=input('Scrolling message · {time} inserts the clock','text');
    body.append(text,rows(choose('Repeat every','frequency',[['0','Off'],...([1,5,15,30,60,300].map(s=>[String(s),s+' seconds']))]),
      choose('Movement','move',['horizontal','bounce','loop','diagonal','vertical','static','random']),
      choose('Speed','scroll',['slowest','slow','normal','fast','faster','insane']),
      choose('Vertical position','position',['top','high','middle','low','bottom','random']),
      choose('Clock position','textClock',['behind','front','off','random']),choose('Text style','textStyle',['enhanced','shadow','plain']),
      input('Key A text','key2'),input('Key B text','key3'),choose('Key text style','keyStyle',[['enhanced','Enhanced'],['plain','Plain']])));
    for(const [key,label] of [['text','Show message'],['key2','Show key A'],['key3','Show key B']])body.append(action(label,()=>api.message(key)));
  }
  function display(){
    body.append(rows(input('Dot color','color','color'),choose('Panel brightness','brightness',['low','medium','high']),
      choose('Contrast','contrast',['normal','enhanced']),choose('Menu style','menuStyle',['enhanced','basic']),
      choose('Startup mode','boot',['express','verbose']),choose('Status light','statusLed',['on','off']),
      choose('Four-button order','buttons',['normal','reversed']),
      choose('Ambient glow','ambient',[['off','Off'],['panel','Match dots'],['#ff3018','Red'],['#24a952','Green'],['#246eff','Blue'],['#c382ff','Purple'],['#ffffff','White']]),
      input('Sleep at','sleep','time'),input('Wake at','wake','time')),
      action(api.asleep()?'Wake display':'Sleep display',()=>api.toggleSleep()),action('Display test',()=>api.test()),action('Restart player',()=>api.restart()));
  }
  function render(){
    lastTab=tab;dialog.dataset.style=settings().menuStyle;
    nav.replaceChildren();for(const t of tabs){const b=button(t,()=>{tab=t;render()});b.setAttribute('aria-pressed',String(t===tab));nav.append(b)}
    body.replaceChildren();({Playback:playback,Animations:animations,Clock:clock,Messages:messages,Display:display})[tab]();
    footer.replaceChildren(status);footer.hidden=false;board?.refresh();
  }
  render();dialog.showModal();
  api.ready?.then(c=>{if(dialog.open&&c!==card){card=c;render()}}).catch(e=>{status.textContent=String(e)});
  return dialog;
}
