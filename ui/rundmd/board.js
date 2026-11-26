// Four-key navigation reads the same controls as the touch menu so both edit the same settings.
import {el,button} from '../common.js';
import {createDisplay} from './display.js';
import {settings} from './model.js';

export function boardMenu(dialog,{tabs,showTab,controls,leave,close}){
  const panel=el('div','dmd-board'),canvas=el('canvas'),keys=el('div','dmd-board-keys'),readout=el('span','dmd-sr');
  readout.setAttribute('aria-live','polite');canvas.setAttribute('aria-hidden','true');
  panel.append(canvas,keys,readout);dialog.append(panel);dialog.dataset.board='true';
  const {render:draw}=createDisplay(canvas),stack=[];
  let index=0,title='Main menu',items=[],message='';
  const mainItems=()=>tabs.map(name=>({name,enter:()=>{showTab(name);push(name,entries)}}));
  let source=mainItems;
  const buttons=[];
  function refresh(){
    items=source();index=Math.min(index,Math.max(0,items.length-1));
    const label=items[index]?.name||'No entries',info=message||items[index]?.value||'';
    const p=settings();
    keys.style.flexDirection=p.buttons==='reversed'?'row-reverse':'row';panel.dataset.led=p.statusLed;
    draw(new Date(),p,{board:{title,label,info,index:index+1,total:items.length,basic:p.menuStyle==='basic'}});
    readout.textContent=title+', '+label+', '+info;
    buttons[0].textContent=stack.length?'Back':'Exit';buttons[3].textContent='OK';
  }
  function push(name,newSource){stack.push({index,title,source});index=0;title=name;source=newSource;refresh()}
  function back(){if(!stack.length){close();return}({index,title,source}=stack.pop());refresh()}
  function move(step){if(items.length)index=(index+step+items.length)%items.length;message='';refresh()}
  function entries(){
    return Array.from(controls().querySelectorAll('select,input,button')).filter(e=>!e.disabled).map(e=>{
      const label=e.getAttribute('aria-label')||e.closest('label')?.querySelector('span')?.textContent||e.textContent;
      const value=e.tagName==='SELECT'?e.selectedOptions[0]?.textContent:e.type==='checkbox'?(e.indeterminate?'Mixed':e.checked?'Enabled':'Disabled'):e.value;
      return {name:label,value,enter(){
        if(e.tagName==='SELECT'){
          push(label,()=>Array.from(e.options).map(o=>({name:o.text,value:o.selected?'Selected':'',enter(){
            e.value=o.value;e.dispatchEvent(new Event('change',{bubbles:true}));back();
          }})));index=Math.max(0,e.selectedIndex);refresh();
        }else if(e.type==='checkbox'){e.click();refresh()}
        else if(e.tagName==='BUTTON'){e.click();if(dialog.open)refresh()}
        else{leave();e.focus();e.scrollIntoView?.({block:'nearest'})}
      }};
    });
  }
  const actions=[back,()=>move(-1),()=>move(1),()=>items[index]?.enter()];
  const labels=['Exit','Previous','Next','OK'];
  actions.forEach((fn,i)=>{const b=button(labels[i],fn);b.title=['C','A','B','D'][i];buttons.push(b);keys.append(b)});
  function keydown(e){
    const pos=({c:0,a:1,b:2,d:3,ArrowLeft:1,ArrowRight:2,Enter:3,Escape:0})[e.key.length===1?e.key.toLowerCase():e.key];
    if(pos===undefined)return;e.preventDefault();e.stopImmediatePropagation();if(!e.repeat)actions[pos]();
  }
  dialog.addEventListener('keydown',keydown,true);refresh();buttons[3].focus();
  return {refresh,dispose(){dialog.removeEventListener('keydown',keydown,true);delete dialog.dataset.board;panel.remove()}};
}
