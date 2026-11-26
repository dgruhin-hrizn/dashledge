import './helpers/bundled-packages.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {followsColors, placementOverride, placementColors, applyTileColors, writePreview, readPreview, clearPreview, PREVIEW_KEY} from '../ui/placement-colors.js';
import {packageInfo} from '../ui/packages.js';
import {packageEntry} from '../ui/widget-catalog.js';

globalThis.window ??= new EventTarget();
globalThis.window.__TAURI__ ??= {core: {invoke: async () => null}};
globalThis.localStorage ??= {store: {}, getItem(k) { return this.store[k] ?? null; }, setItem(k, v) { this.store[k] = String(v); }, removeItem(k) { delete this.store[k]; }};
localStorage.removeItem ??= function (k) { delete this.store[k]; };
const {registerFrame, handleMessage} = await import('../ui/package-bridge.js');

const general = {primary: '#edf0e6', accent: '#f88d4f'};

test('two placements of one widget keep their own colours', () => {
  const page = {slots: [{id: 'a', kind: 'cpu', colors: {accent: '#33aaff'}}, {id: 'b', kind: 'cpu'}]};
  assert.deepEqual(placementColors(page.slots[0], general), {primary: '#edf0e6', accent: '#33aaff'});
  assert.deepEqual(placementColors(page.slots[1], general), general);
  assert.deepEqual(placementColors({colors: {primary: 'red', accent: '#ZZZZZZ'}}, general), general, 'invalid values fall back');
});

test('only real changes are saved as an override', () => {
  assert.deepEqual(placementOverride({primary: '#FFFFFF', accent: '#f88d4f'}, general), {primary: '#ffffff'});
  assert.equal(placementOverride({primary: '#edf0e6', accent: null}, general), null, 'matching General is not an override');
  assert.equal(placementOverride({primary: 'url(x)'}, general), null);
});

test('widgets that follow General colours are the ones that can override them', () => {
  for (const kind of ['cpu', 'clock', 'world', 'focus', 'googledesk']) assert.ok(followsColors(kind), kind);
  for (const kind of ['spotify', 'applemusic', 'photos', 'markets', 'rundmd', 'empty']) assert.ok(!followsColors(kind), kind);
  assert.ok(!followsColors('slackmentions', {slack: true}));
  assert.ok(followsColors('omlx', {bundled: packageInfo.get('omlx')}));
  assert.ok(followsColors('proxmox', {bundled: packageInfo.get('proxmox')}));
  assert.ok(!followsColors('emby', {bundled: packageInfo.get('emby')}));
  assert.ok(followsColors('plugin.x', {custom: packageEntry({id: 'plugin.x', title: 'X', tier: 'view', view: {theme: true}})}));
  assert.ok(!followsColors('plugin.y', {custom: packageEntry({id: 'plugin.y', title: 'Y', tier: 'view', view: {}})}));
  assert.ok(followsColors('plugin.v1', {custom: {id: 'plugin.v1', feed: 'mac'}}), 'single-value widgets use the tile colours');
});

test('a tile scopes its override and returns to General without one', () => {
  const props = new Map(), attrs = new Set();
  const box = {style: {setProperty: (k, v) => props.set(k, v), removeProperty: k => props.delete(k)},
    toggleAttribute: (name, on) => on ? attrs.add(name) : attrs.delete(name)};
  applyTileColors(box, {colors: {accent: '#33aaff'}});
  assert.deepEqual([...props], [['--highlight', '#33aaff']]);
  assert.ok(attrs.has('data-colors'));
  applyTileColors(box, {});
  assert.equal(props.size, 0);
  assert.ok(!attrs.has('data-colors'));
});

test('a package view gets its placement colours and live changes', async () => {
  const posted = [];
  const frame = new EventTarget();
  frame.contentWindow = {postMessage: message => posted.push(message)};
  const unregister = registerFrame(frame, {viewer: 'v', feed: 'f', colors: {accent: '#33aaff'}});
  frame.dispatchEvent(new Event('load'));
  await handleMessage(unregister.entry, {dashledge: 1, type: 'ready'});
  assert.equal(posted.at(-1).state.theme.accent, '#33aaff');
  unregister.colors(null);
  assert.equal(posted.at(-1).state.theme.accent, '#f88d4f', 'back to General');
});

test('a colour draft previews on one placement until it is cleared', () => {
  writePreview('slot-a', {primary: null, accent: '#33AAFF'});
  assert.deepEqual(readPreview(), {slot: 'slot-a', colors: {accent: '#33aaff'}});
  writePreview('slot-a', {primary: '#edf0e6', accent: null});
  assert.deepEqual(readPreview(), {slot: 'slot-a', colors: {primary: '#edf0e6'}}, 'a preview shows even a General colour');
  writePreview('slot-a', {primary: null, accent: null});
  assert.deepEqual(readPreview(), {slot: 'slot-a', colors: null}, 'following General previews no override');
  const stale = JSON.stringify({slot: 'slot-a', colors: {accent: '#33aaff'}, at: Date.now() - 11 * 60 * 1000});
  assert.equal(readPreview(stale), null, 'an abandoned preview expires');
  assert.equal(readPreview('not json'), null);
  clearPreview();
  assert.equal(localStorage.getItem(PREVIEW_KEY), null);
  assert.equal(readPreview(), null);
});
