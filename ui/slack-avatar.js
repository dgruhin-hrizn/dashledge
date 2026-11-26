import {el} from './common.js';

export function slackAvatar(name,photo){
  const a=el('span','sw-avatar',name.split(/[ ._-]+/).filter(Boolean).slice(0,2).map(s=>s[0]).join('').toUpperCase());
  a.style.setProperty('--hue',String(Array.from(name).reduce((n,c)=>n+c.charCodeAt(0)*7,0)%360));a.setAttribute('aria-hidden','true');
  if(photo?.startsWith('https://avatars.slack-edge.com/')){
    const image=el('img');image.alt='';image.referrerPolicy='no-referrer';image.onload=()=>a.replaceChildren(image);image.src=photo;
  }
  return a;
}
