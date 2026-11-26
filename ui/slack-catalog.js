export const slackWidgets = {
  slackworkspace: {name:'Workspace',description:'A full-screen Slack reader for mentions, direct messages, favorite channels and threads.',symbol:'#'},
  slackmentions: {name:'Mentions', description:'Messages that mention you, with a shortcut to each conversation.', symbol:'@'},
  slackdm: {name:'Direct Messages', description:'Recent messages across your private Slack conversations.', symbol:'↗'},
  slackchannel: {name:'Channel Watch', description:'Follow a channel’s recent messages in its own tile.', symbol:'#',field:'Channel name',hint:'general'},
  slacksearch: {name:'Keyword Watch', description:'Track a customer, project or incident with a saved Slack search.', symbol:'⌕',field:'Slack search',hint:'"launch" in:product'},
  slackthread: {name:'Thread Monitor', description:'Read a chosen thread and page through its replies.', symbol:'↳',field:'Slack thread link',hint:'Paste a link to the parent message or a reply'},
  slackpins: {name:'Channel Pins', description:'Open the pinned messages and files from one channel.', symbol:'◆',field:'Channel link or ID',hint:'Paste a Slack channel link or channel ID'},
  slackbookmarks: {name:'Channel Bookmarks', description:'A touch launcher for links bookmarked in a channel.', symbol:'◈',field:'Channel link or ID',hint:'Paste a Slack channel link or channel ID'},
  slackpeople: {name:'People Directory', description:'Browse workspace members and open a direct conversation.', symbol:'◎'},
  slackstatus: {name:'My Status', description:'Set a timed status for a meeting, lunch or focused work.', symbol:'✳'},
  slacksnooze: {name:'Quiet Hours', description:'Pause Slack notifications and see when they will resume.', symbol:'☾'},
};
export function slackTarget(kind,raw=''){
  const value=raw.trim();
  if(kind==='slacksearch'&&value.length>0&&value.length<=512)return value;
  if(kind==='slackchannel'&&/^#?[\w.-]{1,80}$/u.test(value))return value.replace(/^#/,'');
  if(['slackpins','slackbookmarks','slackthread'].includes(kind)){
    if(kind!=='slackthread'&&/^[CGD][A-Z0-9]+$/.test(value))return value;
    let url;try{url=new URL(value)}catch{return ''}
    if(url.protocol!=='https:'||!url.hostname.endsWith('.slack.com'))return '';
    const path=url.pathname.match(/^\/(?:archives|client\/[^/]+)\/([CGD][A-Z0-9]+)(?:\/p(\d{10})(\d{6}))?\/?$/);
    if(!path)return '';
    if(kind!=='slackthread')return path[1];
    const ts=url.searchParams.get('thread_ts')||(path[2]&&path[2]+'.'+path[3]);
    if(/^\d{10}\.\d{6}$/.test(ts))return path[1]+'|'+ts;
  }
  return '';
}
