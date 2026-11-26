// Cache within one connection and serialize lookups so overlapping feeds share requests.
export function memberDirectory(fetchName){
  const entries=new Map();
  let queue=Promise.resolve(),limitedUntil=0,active=true;
  function lookup(id){
    const cached=entries.get(id);
    if(cached&&cached.until>Date.now())return cached.result;
    const entry={until:Infinity};
    entry.result=queue.then(async()=>{
      if(!active||Date.now()<limitedUntil){entry.until=limitedUntil;return ''}
      try{
        const name=await fetchName(id);
        entry.until=Date.now()+(name?3600000:300000);return name;
      }catch(error){
        const retry=String(error).match(/Retry after (\d+)s/);
        if(retry)limitedUntil=Date.now()+Number(retry[1])*1000;
        entry.until=Math.max(limitedUntil,Date.now()+60000);return '';
      }
    });
    queue=entry.result;entries.set(id,entry);return entry.result;
  }
  return {lookup,stop(){active=false}};
}

const memberId=/^[UW][A-Z0-9]{7,}$/;
// Search and history may return either Slack markup or an already flattened mention.
function mentions(text,replace){
  return text.replace(/<@([UW][A-Z0-9]{7,})(?:\|([^>]+))?>|(?<![\w.+-])@([UW][A-Z0-9]{7,})\b/g,
    (_,marked,alias,bare)=>replace(marked||bare,alias));
}
function messages(data){
  return [...(data.messages?.matches||[]),...(Array.isArray(data.messages)?data.messages:[]),...(data.items||[]).map(item=>item.message).filter(Boolean)];
}
function richUsers(elements,visit){
  for(const e of elements||[]){
    if(e.type==='user'&&memberId.test(e.user_id))visit(e.user_id);
    if(e.elements)richUsers(e.elements,visit);
  }
}
export function personalize(data,names){
  const result=structuredClone(data);
  for(const m of messages(result)){
    m.sourceText=m.text;
    m.memberLabels={};
    function label(id,alias){
      const profile=names.get(id);
      const name=(typeof profile==='string'?profile:profile?.name)||alias;
      if(name)m.memberLabels[id]=name;
      return '@'+(name||'member');
    }
    richUsers(m.blocks,id=>label(id));
    if(m.text)m.text=mentions(m.text,label);
    if(memberId.test(m.user)){
      const profile=names.get(m.user);
      m.username=(typeof profile==='string'?profile:profile?.name)||m.username||m.user_profile?.display_name||m.user_profile?.real_name||'Slack member';
      m.avatar=profile?.avatar||m.user_profile?.image_72;
    }else if(m.bot_profile){
      m.username=m.username||m.bot_profile.name;
      m.avatar=m.bot_profile.icons?.image_72;
    }
  }
  return result;
}
export async function memberNames(data,directory){
  const ids=new Set();
  for(const m of messages(data)){
    richUsers(m.blocks,id=>ids.add(id));
    if(memberId.test(m.user))ids.add(m.user);
    mentions(m.text||'',id=>{ids.add(id);return ''});
  }
  return new Map(await Promise.all([...ids].map(async id=>[id,await directory.lookup(id)])));
}
