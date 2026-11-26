import {button,el} from './common.js';
import {openTouchKeyboard} from './search-keyboard.js';

const defaults=['SPY','QQQ','DIA','IWM','AAPL','NVDA','MSFT','AMZN','GOOGL','TSLA'];
export function watchlist(slot){return slot.marketSymbols?.length?[...slot.marketSymbols]:[...defaults]}
export function addSymbol(list,raw){
  const ticker=raw.trim().toUpperCase();
  if(!/^[A-Z][A-Z0-9]*(?:[.-][A-Z0-9]+)*$/.test(ticker)||ticker.length>12)throw Error('Enter a US ticker such as AMD or BRK.B.');
  if(list.includes(ticker))throw Error(ticker+' is already on this list.');
  if(list.length>=30)throw Error('A watchlist holds up to 30 symbols.');
  list.push(ticker);
}
export function editWatchlist(slot,save,touch=false){
  const draft=watchlist(slot),dialog=el('dialog','mw-editor'),list=el('div','mw-chips'),status=el('p'),input=el('input');
  dialog.setAttribute('aria-label','Edit watchlist');status.setAttribute('role','status');
  function draw(){
    list.replaceChildren(...draft.map(t=>{
      const b=button(t+' ×',()=>{draft.splice(draft.indexOf(t),1);draw()});
      b.setAttribute('aria-label','Remove '+t);return b;
    }));
  }
  function add(raw){try{addSymbol(draft,raw);status.textContent='';draw();return true}catch(e){status.textContent=e.message;return false}}
  const form=el('form');input.placeholder='Ticker, e.g. AMD';input.setAttribute('aria-label','Ticker symbol');
  if(touch){
    form.append(button('Add symbol',()=>{
      const sheet=openTouchKeyboard({title:'Add symbol',brand:'Market Watch',icon:'widget-icons/markets.svg',placeholder:'Ticker, e.g. AMD',actionLabel:'Add',onSubmit:()=>{
        if(add(sheet.input.value))sheet.dialog.close();else sheet.content.textContent=status.textContent;
      }});
    }));
  }else{const submit=el('button','','Add symbol');form.append(input,submit);form.onsubmit=e=>{e.preventDefault();if(add(input.value)){input.value='';input.focus()}}}
  const footer=el('footer');footer.append(button('Cancel',()=>dialog.close()),button('Save watchlist',()=>{
    if(input.value.trim()){if(!add(input.value))return;input.value=''}
    if(!draft.length){status.textContent='Add at least one symbol.';return}
    try{save({marketSymbols:[...draft],marketSymbol:draft.includes(slot.marketSymbol)?slot.marketSymbol:draft[0]});dialog.close()}catch(e){status.textContent=String(e)}
  }));
  dialog.append(el('h2','','Edit watchlist'),el('p','','Tap a symbol to remove it from this placement.'),form,list,status,footer);
  draw();document.body.append(dialog);dialog.onclose=()=>dialog.remove();dialog.showModal();
}
