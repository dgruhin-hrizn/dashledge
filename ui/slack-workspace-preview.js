// A local, explicitly labeled workspace lets people try the reader before connecting.
const now=Math.floor(Date.now()/1000);
const entries=[
  ['Maya Chen','design','The first proofs are in.','The warm white stock gives the new identity room to breathe. I’d go with the second cover for Friday’s review.',8],
  ['Theo James','launch','Which cut should we send to the studio?','The 30-second edit has the new end card. The shorter cut still uses the previous wordmark.',23],
  ['Amara Reed','studio','Material samples arrived this morning.','I’ve set them out by finish. The brushed aluminum looks especially good in daylight.',42],
  ['Jon Bell','design','Updated the spacing on the new lockup.','The small-format version now has its own optical adjustments.',64],
  ['Nina Park','launch','Friday’s running order is ready.','Doors at ten, film at eleven, then a walkthrough with the design team.',91],
];
const index=entries.map(([username,channel,title,body,minutes],i)=>({
  username,user:'preview-'+i,channel:{name:channel,id:'C'+channel.toUpperCase()},ts:(now-minutes*60)+'.000001',text:title+'\n\n'+body
}));
const replies=[
  [['Jon Bell','Agreed on the second cover. The extra margin makes the type feel much calmer.'],['Maya Chen','I’ll mark that one for the printer.']],
  [['Nina Park','Send the longer cut. We can use the short version for the event reminder.']],
  [['Maya Chen','I’ll come by after lunch to compare the finishes.']],[],[],
];
export const previewWorkspace={team:'Fieldwork Studio',teamId:'workspace-preview',preview:true};
export function previewFeed(kind,target){
  if(kind==='slackthread'){
    const i=index.findIndex(m=>target===m.channel.id+'|'+m.ts);
    const messages=i<0?[]:[{...index[i],reply_count:replies[i].length},...replies[i].map(([username,text],j)=>({username,text,ts:(Math.floor(Number(index[i].ts))+60+j*60)+'.000002'}))];
    return {version:1,data:{messages}};
  }
  const matches=kind==='slackchannel'?index.filter(m=>m.channel.name===target):kind==='slackdm'?[index[1],index[2]]:index;
  return {version:1,data:{messages:{matches}}};
}
