import {el,button} from './common.js';

function searchKeyboard(input,submit,actionLabel){
  const board=el('div','sp-keyboard');
  board.setAttribute('role','group');board.setAttribute('aria-label','On-screen keyboard');
  let symbols=false,shift=false;

  function edit(text,backspace=false){
    let start=input.selectionStart;
    const end=input.selectionEnd;
    if(backspace&&start===end){
      const previous=Array.from(input.value.slice(0,start)).pop();
      start-=previous?.length||0;
    }
    if(input.maxLength>=0&&input.value.length-(end-start)+text.length>input.maxLength)return;
    input.setRangeText(text,start,end,'end');
    input.focus({preventScroll:true});
    input.dispatchEvent(new Event('input',{bubbles:true}));
    if(shift&&!symbols){shift=false;draw()}
  }

  function draw(){
    board.replaceChildren();
    const rows=symbols?['1234567890','@#$%&*-+=_','!?.,:;()/']:['qwertyuiop','asdfghjkl','zxcvbnm'];
    for(const [index,letters] of rows.entries()){
      const row=el('div','sp-key-row');
      if(index===2&&!symbols){
        const key=button('⇧',()=>{shift=!shift;draw()},'sp-key-fn');
        key.setAttribute('aria-label','Shift');key.setAttribute('aria-pressed',String(shift));row.append(key);
      }
      for(const char of letters){
        const letter=shift&&!symbols?char.toUpperCase():char;
        row.append(button(letter,()=>edit(letter)));
      }
      if(index===2){
        const del=button('⌫',()=>edit('',true),'sp-key-fn');
        del.setAttribute('aria-label','Backspace');row.append(del);
      }
      board.append(row);
    }
    const actions=el('div','sp-key-row sp-key-actions');
    actions.append(button(symbols?'ABC':'?123',()=>{symbols=!symbols;shift=false;draw()},'sp-key-fn'),
      button("'",()=>edit("'")),button('Space',()=>edit(' '),'sp-key-space'),button(actionLabel,submit,'sp-key-submit'));
    board.append(actions);
  }
  // Keep the caret and selection when a pointer operates a key.
  board.onmousedown=e=>e.preventDefault();
  draw();return board;
}


export function openTouchKeyboard({title,brand,icon,placeholder,label=placeholder,actionLabel='Search',theme='',maxLength,onSubmit}){
  const dialog=el('dialog','sp-library sp-browser sp-search-sheet');
  if(theme)dialog.classList.add(theme);
  dialog.setAttribute('aria-label',title);
  const header=el('header'),identity=el('span','sp-search-brand',brand),logo=el('img');
  logo.src=icon;logo.alt='';identity.prepend(logo);
  const close=button('×',()=>dialog.close());close.setAttribute('aria-label','Close');header.append(identity,close);

  const panes=el('div','sp-search-panes'),left=el('div','sp-search-left'),field=el('div','sp-search-field');
  const input=el('input','sp-search');input.type='search';input.inputMode='none';input.placeholder=placeholder;
  input.setAttribute('aria-label',label);if(maxLength!=null)input.maxLength=maxLength;
  const clear=button('×',()=>{input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));input.focus()});
  clear.setAttribute('aria-label','Clear '+label.toLowerCase());clear.hidden=true;
  input.addEventListener('input',()=>clear.hidden=!input.value);
  input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();onSubmit()}});
  const content=el('div','sp-library-scroll');
  field.append(input,clear);left.append(el('h2','',title),field,content);panes.append(left,searchKeyboard(input,onSubmit,actionLabel));
  dialog.append(header,panes);dialog.onclose=()=>dialog.remove();document.body.append(dialog);
  dialog.showModal();input.focus();return {dialog,input,content};
}
