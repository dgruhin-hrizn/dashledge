import test from 'node:test';
import assert from 'node:assert/strict';
import {addSymbol,watchlist} from '../ui/market-watchlist.js';
import {applyTrade,sessionAt} from '../widgets/collectors/markets/session.mjs';

test('watchlist edits normalize class shares and preserve other placements',()=>{
  const first=watchlist({}),second=watchlist({});
  addSymbol(first,' brk.b ');assert.equal(first.at(-1),'BRK.B');assert(!second.includes('BRK.B'));
  assert.throws(()=>addSymbol(first,'BRK.B'));assert.throws(()=>addSymbol(first,'https://example.com'));
  assert.deepEqual(watchlist({marketSymbol:'NVDA'}),second);
});
test('half-day extended trades retain the regular baseline and reset on the next date',()=>{
  const calendar=new Map([['2026-11-27',{open:'09:30',close:'13:00'}],['2026-11-30',{open:'09:30',close:'16:00'}]]);
  const s={points:[]},trade=(date,p)=>applyTrade(s,Date.parse(date),p,calendar);
  trade('2026-11-27T17:59:00Z',105);trade('2026-11-27T18:01:00Z',107);
  assert.equal(s.session,'After hours');assert.equal(s.regularClose,105);assert.equal(s.extendedStart,Date.parse('2026-11-27T18:01:00Z'));
  trade('2026-11-30T13:01:00Z',109);assert.equal(s.session,'Pre-market');assert.equal(s.regularClose,undefined);assert.equal(s.extendedStart,undefined);
  assert.equal(sessionAt(Date.parse('2026-11-26T19:00:00Z'),calendar),null);
});
