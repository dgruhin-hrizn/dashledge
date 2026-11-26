import test from 'node:test';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {agendaItems} from '../ui/google-desk.js';
import {widgetInfo,installed} from '../ui/widget-catalog.js';
import {initial} from '../ui/model.js';

test('Mail & Calendar appears in the layout catalog for existing configurations',()=>{
  const config=initial();
  assert.equal(widgetInfo(config,'googledesk').title,'Mail & Calendar');
  assert.equal(installed(config,'googledesk'),true);
});
test('agenda keeps ongoing meetings and respects the exclusive end of all-day events',()=>{
  const date=value=>({date:value});
  const moment=value=>({dateTime:'2026-11-26T'+value});
  const items=[
    {summary:'Tomorrow',start:date('2026-11-27'),end:date('2026-11-28')},
    {summary:'Yesterday',start:date('2026-11-25'),end:date('2026-11-26')},
    {summary:'Now',start:moment('10:00:00'),end:moment('11:00:00')},
    {summary:'Finished',start:moment('08:00:00'),end:moment('10:15:00')}
  ];
  assert.deepEqual(agendaItems(items,new Date('2026-11-26T10:15:00')).map(x=>[x.summary,x.allDay]),[['Now',false],['Tomorrow',true]]);
});

test('the hardened Mac build includes the EventKit entitlement and calendar usage description',()=>{
  const read=name=>readFileSync(new URL('../src-tauri/'+name,import.meta.url),'utf8');
  assert.match(read('Entitlements.plist'),/<key>com\.apple\.security\.personal-information\.calendars<\/key>\s*<true\s*\/>/);
  assert.match(read('Info.plist'),/<key>NSCalendarsFullAccessUsageDescription<\/key>\s*<string>[^<]+<\/string>/);
});

test('hiding one calendar preserves sibling calendars and namesakes in other accounts',()=>{
  const items=['work-primary','work-team','home-team'].map(calendarId=>({
    calendarId,calendar:calendarId.endsWith('team')?'Team':'Primary',
    start:{date:'2026-11-26'},end:{date:'2026-11-27'}
  }));
  const visible=agendaItems(items,new Date('2026-11-26T09:00:00'),new Set(['work-team']));
  assert.deepEqual(visible.map(e=>e.calendarId),['work-primary','home-team']);
});

test('an event ending between minute ticks disappears at its end boundary from the cached snapshot',()=>{
  const event={start:{dateTime:'2026-11-26T10:00:00Z'},end:{dateTime:'2026-11-26T10:04:17Z'}};
  assert.equal(agendaItems([event],new Date('2026-11-26T10:04:16.999Z')).length,1);
  assert.equal(agendaItems([event],new Date('2026-11-26T10:04:17Z')).length,0);
});
