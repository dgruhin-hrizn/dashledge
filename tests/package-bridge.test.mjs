import test from 'node:test';
import assert from 'node:assert/strict';

// A minimal browser surface for the host bridge.
const calls = [];
globalThis.window = new EventTarget();
globalThis.window.__TAURI__ = {core: {invoke: async (cmd, args) => { calls.push([cmd, args]); return 'done'; }}};
globalThis.localStorage = {store: {}, getItem(k) { return this.store[k] ?? null; }, setItem(k, v) { this.store[k] = String(v); }};
globalThis.CustomEvent ??= class extends Event { constructor(type, init) { super(type); this.detail = init?.detail; } };
localStorage.setItem('edge.general.v1', JSON.stringify({primary: '#111111', accent: '#222222'}));
const {registerFrame, handleMessage, packageState, isPackageWindow} = await import('../ui/package-bridge.js');

function fakeFrame() {
  const posted = [];
  const contentWindow = {postMessage: (message, origin) => posted.push([message, origin])};
  const frame = new EventTarget();
  frame.contentWindow = contentWindow;
  return {frame, posted, load: () => frame.dispatchEvent(new Event('load'))};
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('a frame gets its state when its SDK is ready', async () => {
  const {frame, posted, load} = fakeFrame();
  registerFrame(frame, {viewer: 'v1', feed: 'f1'});
  load();
  window.dispatchEvent(Object.assign(new Event('message'), {source: frame.contentWindow, data: {dashledge: 1, type: 'ready'}}));
  await settle();
  const [message] = posted.at(-1);
  assert.equal(message.type, 'state');
  assert.deepEqual(message.state, {instanceID: 'omlx-dashboard@v1', touchMode: false, displayName: '',
    theme: {mode: 'dark', primary: '#111111', accent: '#222222'}});
  assert.equal(packageState({viewer: 'x', displayName: 'Tower'}).displayName, 'Tower');
});

test('messages from windows that are not registered package frames are ignored', async () => {
  const before = calls.length;
  const stranger = {postMessage() { throw Error('should not reply'); }};
  window.dispatchEvent(Object.assign(new Event('message'), {source: stranger,
    data: {dashledge: 1, type: 'command', id: 1, name: 'model', args: {}}}));
  await settle();
  assert.equal(calls.length, before);
  assert.equal(isPackageWindow(stranger), false);
});

test('only commands the manifest declares reach the host', async () => {
  const declared = fakeFrame(), plain = fakeFrame();
  const entry = {frame: declared.frame, viewer: 'v2', feed: 'f2', commands: ['model']};
  await handleMessage(entry, {type: 'command', id: 7, name: 'model', args: {action: 'load', model: 'm'}});
  assert.deepEqual(calls.at(-1), ['widget_model_action', {id: 'f2', viewer: 'v2', command: {action: 'load', model: 'm'}}]);
  assert.deepEqual(declared.posted.at(-1)[0], {dashledge: 1, type: 'reply', id: 7, value: 'done', error: undefined});
  const before = calls.length;
  await handleMessage({frame: plain.frame, viewer: 'v3', feed: 'f3', commands: []}, {type: 'command', id: 8, name: 'model', args: {}});
  await handleMessage({frame: plain.frame, viewer: 'v3', feed: 'f3', commands: ['model']}, {type: 'command', id: 9, name: 'set_secret', args: {}});
  assert.equal(calls.length, before);
  assert.deepEqual(plain.posted.map(([m]) => m.error), ['Unknown widget command', 'Unknown widget command']);
});

test('swipes, the page picker and gesture verdicts are forwarded safely', async () => {
  const {frame} = fakeFrame();
  const entry = {frame, viewer: 'v4', feed: 'f4', commands: []};
  const steps = [];
  window.addEventListener('edgepageswipe', e => steps.push(e.detail));
  let picker = 0;
  window.addEventListener('edgepagepicker', () => picker++);
  await handleMessage(entry, {type: 'swipe', step: 1});
  await handleMessage(entry, {type: 'swipe', step: 40});
  await handleMessage(entry, {type: 'pagepicker'});
  await handleMessage(entry, {type: 'gesture', page: 'yes'});
  assert.deepEqual(steps, [1]);
  assert.equal(picker, 1);
  assert.equal(frame.__gestureVerdict, false, 'only a literal true turns the page');
  await handleMessage(entry, {type: 'gesture', page: true});
  assert.equal(frame.__gestureVerdict, true);
});
