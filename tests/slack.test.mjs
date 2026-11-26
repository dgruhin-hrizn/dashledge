import assert from 'node:assert/strict';
import {test} from 'node:test';
import {slackTarget,slackWidgets} from '../ui/slack-catalog.js';
import {rowsFor} from '../ui/slack.js';
import {assignWidget} from '../ui/page-actions.js';
import {widgetInfo,installed} from '../ui/widget-catalog.js';
import {initial} from '../ui/model.js';

test('each Slack widget is independently placeable and replacing a watch clears its target',()=>{
  const config=initial();
  for(const [kind,{name}] of Object.entries(slackWidgets)){
    assert.equal(widgetInfo(config,kind).title,'Slack '+name);
    assert.ok(installed(config,kind));
    const s=assignWidget(config,kind,{id:'tile',slackTarget:'old'});
    assert.equal(s.kind,kind);assert.equal(s.id,'tile');assert.equal(s.slackTarget,undefined);
  }
});
test('watch targets accept channel links and resolve a reply to its parent thread',()=>{
  const link='https://example.slack.com/archives/C123/p1710000000123456';
  assert.equal(slackTarget('slackpins',link),'C123');
  assert.equal(slackTarget('slackthread',link),'C123|1710000000.123456');
  assert.equal(slackTarget('slackthread',link+'?thread_ts=1700000000.654321'),'C123|1700000000.654321');
  assert.equal(slackTarget('slackbookmarks','https://app.slack.com/client/T123/C123'),'C123');
  assert.equal(slackTarget('slackthread','https://elsewhere.com/archives/C123/p1710000000123456'),'');
  assert.equal(slackTarget('slackchannel',' #launch '),'launch');
});
test('Slack rows preserve message text, location and workspace ownership',()=>{
  const info={url:'https://example.slack.com/',teamId:'T123'};
  const [row]=rowsFor('slackpins',{items:[{message:{text:'<https://example.com|Brief> &amp; notes',ts:'1710000000.123456'}}]},info,'C123');
  assert.equal(row.title,'Brief & notes');
  assert.equal(row.link,'https://example.slack.com/archives/C123/p1710000000123456');
  assert.deepEqual(rowsFor('slackpeople',{members:[{deleted:true},{is_bot:true}]},info,''),[]);
});
test('two channel watches keep independent targets after saving a page',()=>{
  const config=initial(),page=config.pages[0];
  for(const [index,channel] of ['engineering','customer-success'].entries()){
    const placed=assignWidget(config,'slackchannel',page.slots[index]);
    page.slots[index]={...placed,slackTarget:channel};
  }
  const restored=JSON.parse(JSON.stringify(config)).pages[0].slots.slice(0,2);
  assert.notEqual(restored[0].id,restored[1].id);
  assert.deepEqual(restored.map(s=>slackTarget(s.kind,s.slackTarget)),['engineering','customer-success']);
});

test('workspace opens the parent conversation when a search result is a thread reply',async()=>{
  const {parentTarget}=await import('../ui/slack-workspace.js');
  const m={ts:'1700000000.000013',channel:{id:'C12'},permalink:'https://example.slack.com/archives/C12/p1700000000000013?thread_ts=1700000000.000010'};
  assert.equal(parentTarget(m),'C12|1700000000.000010');
  assert.equal(parentTarget({...m,permalink:undefined}),'C12|1700000000.000013');
  assert.equal(parentTarget({...m,thread_ts:'1700000000.000009'}),'C12|1700000000.000009');
});

test('Slack message, pin and reply mentions share per-account profile lookups',async()=>{
  const {memberDirectory,memberNames,personalize}=await import('../ui/slack-members.js');
  const calls=[],directory=memberDirectory(async id=>{calls.push(id);return id==='U12345678'?'Maya Chen':''});
  const m={user:'U12345678',text:'<@U12345678> ping @U12345678, <@W12345678|Sam> and <@W87654321>.'};
  for(const feed of [{messages:{matches:[m]}},{messages:[m]},{items:[{message:m}]}]){
    const names=await memberNames(feed,directory),out=personalize(feed,names);
    const result=out.messages?.matches?.[0]||out.messages?.[0]||out.items[0].message;
    assert.equal(result.text,'@Maya Chen ping @Maya Chen, @Sam and @member.');
    assert.equal(result.username,'Maya Chen');
  }
  assert.equal(new Set(calls).size,3);assert.equal(calls.length,3);
  assert.match(m.text,/<@U12345678>/);
});

test('rich Slack blocks take precedence and resolve mentions that exist only in blocks',async()=>{
  const {messageBlocks,messageSummary}=await import('../ui/slack-message.js');
  const {memberNames,personalize}=await import('../ui/slack-members.js');
  const m={text:'Notification fallback',blocks:[{type:'rich_text',elements:[
    {type:'rich_text_section',elements:[{type:'user',user_id:'U12345678'},{type:'text',text:' updated ',style:{italic:true}},{type:'link',url:'https://example.com',text:'notes',style:{bold:true}}]},
    {type:'rich_text_list',style:'ordered',offset:1,indent:1,elements:[{type:'rich_text_section',elements:[{type:'emoji',name:'wave',unicode:'1f44b'}]}]},
    {type:'rich_text_preformatted',elements:[{type:'text',text:'<tag> *literal*'}]}
  ]}]};
  const feed={messages:[m]},names=await memberNames(feed,{lookup:async()=>'Jamie'});
  const [ready]=personalize(feed,names).messages;
  assert.equal(messageSummary(ready),'@Jamie updated notes\n2. 👋\n<tag> *literal*');
  assert.deepEqual(messageBlocks(ready)[0].parts[2],{url:'https://example.com/',text:'notes',style:{bold:true}});
});
test('mrkdwn, quotes and literal code survive the search feed without interpreting HTML',async()=>{
  const {messageBlocks,messageSummary}=await import('../ui/slack-message.js');
  const m={text:'*bold* _italic_ ~removed~ :wave:\n&gt; <https://example.com|A &amp; B>\n```<@U12345678> *literal*```'};
  const blocks=messageBlocks(m);
  assert.ok(blocks[0].parts.some(p=>p.style?.bold&&p.text==='bold'));
  assert.ok(blocks[0].parts.some(p=>p.style?.italic&&p.text==='italic'));
  assert.ok(blocks[0].parts.some(p=>p.style?.strike&&p.text==='removed'));
  assert.equal(blocks[1].type,'quote');assert.equal(blocks[1].parts[0].text,'A & B');
  assert.match(messageSummary(m),/👋/);assert.equal(blocks.find(b=>b.type==='pre').parts[0].text,'<@U12345678> *literal*');
});
