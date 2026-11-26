import {makePage, slot, titles} from './model.js';
import {defaultSource,installed} from './widget-catalog.js';
import {button, el} from './common.js';

export function appendPage(config){
  const names=new Set(config.pages.map(page=>page.name));
  let n=config.pages.length+1;
  while(names.has('Page '+n))n++;
  const page=makePage('Page '+n,'One');
  config.pages.push(page);
  return page;
}

export function assignWidget(config,kind,previous){
  const instance=slot(kind);
  if(previous)instance.id=previous.id;
  instance.source=defaultSource(config,kind);
  return instance;
}

export function pickWidget(config, choose){
  const dlg=el('dialog','widget-picker');
  dlg.setAttribute('aria-label','Add widget');
  const head=el('div','picker-head');
  head.append(el('h2','','Add widget'),button('Cancel',()=>dlg.close()));
  const options=el('div','catalog');
  for(const [kind,name] of [...Object.entries(titles),...config.plugins.map(p=>[p.id,p.title])]){
    if(!installed(config,kind))continue;
    options.append(button(name,()=>{choose(kind);dlg.close()}));
  }
  dlg.append(head,options);
  dlg.onclose=()=>dlg.remove();
  document.body.append(dlg);dlg.showModal();
}
