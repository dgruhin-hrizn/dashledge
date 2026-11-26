import {el} from './common.js';
import {emojiNames} from './vendor/emoji-names.js';

const decode=s=>s.replace(/&(amp|lt|gt);/g,(_,k)=>({amp:'&',lt:'<',gt:'>'})[k]);
export function slackEmoji(name,unicode){
  if(unicode&&/^[\da-f]{2,6}(?:-[\da-f]{2,6})*$/i.test(unicode)){
    const points=unicode.split('-').map(x=>parseInt(x,16));
    if(points.every(n=>n<=0x10ffff))return String.fromCodePoint(...points);
  }
  if(/^skin-tone-[2-6]$/.test(name))return String.fromCodePoint(0x1f3fb+Number(name.at(-1))-2);
  return Object.hasOwn(emojiNames,name)?emojiNames[name]:':'+name+':';
}
function link(text,url){
  // Only expose links which the native Slack opener can launch.
  try{const u=new URL(url);if(['https:','http:','mailto:','tel:'].includes(u.protocol)&&!u.username&&!u.password)return {text,url:u.href}}catch{}
  return {text};
}
function mention(text){return {text,mention:true}}
function user(id,alias,m){return mention('@'+(m.memberLabels?.[id]||alias||'member'))}
function reference(raw,m){
  const split=raw.indexOf('|'),id=split<0?raw:raw.slice(0,split),label=split<0?'':decode(raw.slice(split+1));
  if(id.startsWith('@'))return user(id.slice(1),label,m);
  if(id.startsWith('#'))return mention('#'+(label||(id.slice(1)===m.channel?.id&&m.channel.name)||'channel'));
  if(id.startsWith('!date^'))return {text:label||new Date(Number(id.split('^')[1])*1000).toLocaleString()};
  if(id.startsWith('!subteam^'))return mention(label||'@user group');
  if(/^!(here|channel|everyone)$/.test(id))return mention('@'+id.slice(1));
  if(/^(https?:\/\/|mailto:|tel:)/i.test(id))return link(label||decode(id).replace(/^mailto:/,''),decode(id));
  return {text:decode('<'+raw+'>')};
}
function inline(text,m,style={},depth=0){
  if(depth>5)return [{text:decode(text),style}];
  const tokens=/`([^`\n]+)`|<([^<>\n]+)>|(?<![\w.+-])@([UW][A-Z0-9]{7,})\b|:([\w+-]+):|(?<![\p{L}\p{N}])([*_~])(?=\S)([^\n]+?)(?<=\S)\5(?![\p{L}\p{N}])/gu;
  const parts=[];let end=0;
  for(const hit of text.matchAll(tokens)){
    if(hit.index>end)parts.push({text:decode(text.slice(end,hit.index)),style});
    const [,code,ref,id,name,mark,inner]=hit;
    if(mark)parts.push(...inline(inner,m,{...style,[{'*':'bold','_':'italic','~':'strike'}[mark]]:true},depth+1));
    else if(code)parts.push({text:decode(code),style:{...style,code:true}});
    else parts.push({...((ref&&reference(ref,m))||(id&&user(id,'',m))||{text:slackEmoji(name)}),style});
    end=hit.index+hit[0].length;
  }
  if(end<text.length)parts.push({text:decode(text.slice(end)),style});
  return parts;
}
function fallback(text,m){
  const out=[],sections=text.split('```');
  for(const [i,s] of sections.entries()){
    if(i%2){out.push({type:'pre',parts:[{text:decode(s.replace(/^\n|\n$/g,''))}]});continue}
    for(const line of s.split('\n')){
      const quote=/^(?:>|&gt;) ?/.exec(line),list=/^(\s*)([-•]|\d+\.)\s+/.exec(line);
      const type=quote?'quote':list?'list':'paragraph';
      out.push({type,marker:list?.[2],indent:list?Math.min(8,Math.floor(list[1].length/2)):0,parts:inline(line.slice((quote||list)?.[0].length||0),m)});
    }
  }
  return out;
}
function channelLabel(id,m){
  if(m.channel?.id===id)return m.channel.name;
  return (m.sourceText||m.text||'').match(new RegExp('<#'+id.replace(/[^A-Z0-9]/g,'')+'\\|([^>]+)>'))?.[1];
}
function richPart(e,m){
  let part;
  switch(e.type){
    case 'text':part={text:e.text};break;
    case 'link':part=link(e.text||e.url,e.url);break;
    case 'emoji':part={text:slackEmoji(e.name,e.unicode)};break;
    case 'user':part=user(e.user_id,null,m);break;
    case 'channel':part=mention('#'+(channelLabel(e.channel_id,m)||'channel'));break;
    case 'broadcast':part=mention('@'+e.range);break;
    case 'usergroup':{
      const alias=(m.sourceText||m.text||'').split('<!subteam^'+e.usergroup_id+'|')[1]?.split('>')[0];
      part=mention(alias||'@user group');break;
    }
    case 'date':part={text:e.fallback||new Date(e.timestamp*1000).toLocaleString()};break;
    default:part={text:e.text||e.value||''};
  }
  return {...part,style:e.style};
}
export function messageBlocks(m){
  const out=[];
  for(const b of m.blocks||[]){
    if(b.type==='rich_text'){
      for(const item of b.elements||[]){
        if(item.type==='rich_text_list'){
          (item.elements||[]).forEach((section,i)=>out.push({type:'list',indent:item.indent||0,
            marker:item.style==='ordered'?((item.offset||0)+i+1)+'.':'•',parts:(section.elements||[]).map(e=>richPart(e,m))}));
        }else{
          const type={rich_text_section:'paragraph',rich_text_preformatted:'pre',rich_text_quote:'quote'}[item.type];
          if(type)out.push({type,parts:(item.elements||[]).map(e=>richPart(e,m))});
        }
      }
    }else if(['section','header','context'].includes(b.type)){
      for(const field of [b.text,...(b.fields||[]),...(b.elements||[])].filter(Boolean)){
        if(field.type==='mrkdwn')out.push(...fallback(field.text,m));
        if(field.type==='plain_text')out.push({type:'paragraph',parts:[{text:field.text,style:{bold:b.type==='header'}}]});
      }
    }
  }
  if(!out.some(b=>b.parts.some(p=>p.text)))out.splice(0,out.length,...fallback(m.sourceText??m.text??'',m));
  for(const a of m.attachments||[]){
    const text=a.title||a.pretext||a.fallback;
    if(text&&text!==m.text)out.push({type:'quote',parts:[link(text,a.title_link)]});
    if(a.text&&a.text!==text&&a.text!==m.text)out.push(...fallback(a.text,m));
  }
  for(const f of m.files||[])out.push({type:'file',parts:[link(f.title||f.name||'Shared file',f.permalink)]});
  return out.some(b=>b.parts.some(p=>p.text))?out:[{type:'paragraph',parts:[{text:'Shared attachment'}]}];
}
export function messageSummary(m){
  return messageBlocks(m).map(b=>(b.marker?b.marker+' ':'')+b.parts.map(p=>p.text).join('')).join('\n').trim();
}
export function renderMessage(m,{preview=false,open}={}){
  const body=el(preview?'span':'div','sl-message-body');
  for(const b of messageBlocks(m)){
    const line=el(preview?'span':b.type==='pre'?'pre':b.type==='quote'?'blockquote':'div','sl-msg-'+b.type);
    if(b.marker){line.style.paddingInlineStart=Math.min(b.indent||0,8)+'em';line.append(el('span','sl-list-marker',b.marker==='-'?'•':b.marker))}
    for(const p of b.parts){
      const a=el(p.url&&open&&!preview?'a':'span',p.mention?'sl-mention':p.url?'sl-text-link':'');
      if(a.tagName==='A'){a.href=p.url;a.onclick=e=>{e.preventDefault();open(p.url)}}
      let inner=a;
      for(const [key,tag] of [['bold','strong'],['italic','em'],['strike','s'],['underline','u'],['code','code']]){
        if(p.style?.[key]){const wrap=el(tag);inner.append(wrap);inner=wrap}
      }
      inner.textContent=p.text;line.append(a);
    }
    body.append(line);
    if(preview)body.append(' ');
  }
  if(!preview&&m.edited?.ts)body.append(el('small','sl-edited','(edited)'));
  if(!preview&&m.reactions?.length){
    const row=el('div','sl-reactions');
    for(const r of m.reactions){const badge=el('span','',slackEmoji(r.name)+' '+r.count);badge.title=':'+r.name+':';row.append(badge)}
    body.append(row);
  }
  return body;
}
