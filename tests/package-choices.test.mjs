import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// A minimal browser surface for the host bridge.
globalThis.window = new EventTarget();
const invoked = [];
globalThis.window.__TAURI__ = {core: {invoke: async (method, args) => { invoked.push([method, args]); return null; }}};
globalThis.localStorage = {store: {}, getItem(k) { return this.store[k] ?? null; }, setItem(k, v) { this.store[k] = String(v); }};
globalThis.CustomEvent ??= class extends Event { constructor(type, init) { super(type); this.detail = init?.detail; } };
const {registerFrame, handleMessage} = await import('../ui/package-bridge.js');
const {settingValues} = await import('../ui/package-settings.js');
const {cleanOptions, readChoices, requestRefresh, watchChoices} = await import('../ui/package-choices.js');
const {permissionSummary} = await import('../ui/package-manifest.js');

// The plans manifest, with the defaults Rust fills in.
const manifest = JSON.parse(await readFile(new URL('../widgets/packages/plans/widget.json', import.meta.url), 'utf8'));
const schema = manifest.settings.map(s => s.type === 'names' ? {...s, default: {}} : s);

function frameFor(options) {
  const posted = [];
  const frame = new EventTarget();
  frame.contentWindow = {postMessage: message => posted.push(message)};
  const unregister = registerFrame(frame, {viewer: 'v', feed: 'feed-1', kind: 'plans', title: 'AI Plan Monitor', schema,
    commands: ['refresh'], ...options});
  frame.dispatchEvent(new Event('load'));
  return {entry: unregister.entry, posted, unregister};
}
const command = async (entry, posted, name, args) => {
  await handleMessage(entry, {dashledge: 1, type: 'command', id: 3, name, args});
  return posted.at(-1);
};

test('saved accounts and names survive when nothing is offered right now', () => {
  const saved = {accounts: ['claude:work', 'codex:local'], names: {'claude:work': 'Work', 'codex:gone': 'Old laptop'}};
  assert.deepEqual(settingValues(schema, saved), saved, 'dynamic values are checked by shape, not by what is offered');
  assert.deepEqual(settingValues(schema, {}), {accounts: ['*'], names: {}});
  assert.deepEqual(settingValues(schema, {accounts: []}).accounts, [], 'an empty choice is kept, and the view says so');
  for (const bad of ['claude:main', ['*', 'a'], ['a', 'a'], ['has space'], [3]])
    assert.deepEqual(settingValues(schema, {accounts: bad}).accounts, ['*'], JSON.stringify(bad));
  assert.deepEqual(settingValues(schema, {names: {'bad key': 'x', ok: 'y'}}).names, {}, 'a malformed map falls back whole');
  assert.deepEqual(settingValues(schema, {names: {a: '  Trimmed ', b: '   '}}).names, {a: 'Trimmed'}, 'blank names are dropped');
  assert.deepEqual(settingValues(schema, {names: {a: 'x'.repeat(49)}}).names, {}, 'names longer than maxLength are refused');
});

test('a view offers options for its dynamic settings only', async () => {
  localStorage.store = {};
  const {entry, posted} = frameFor({permissions: ['settings', 'settings.choices'], source: ''});
  let changes = 0;
  const stop = watchChoices(() => changes++);
  const options = [{value: 'claude:main', label: 'Claude Max · Default', detail: '72% left'}, {value: 'codex:local', label: 'Codex'}];
  assert.equal((await command(entry, posted, 'settings.offer', {setting: 'accounts', options})).value, true);
  assert.deepEqual(readChoices('plans', '').accounts.map(o => o.value), ['claude:main', 'codex:local']);
  assert.equal(changes, 1);
  await command(entry, posted, 'settings.offer', {setting: 'accounts', options});
  assert.equal(changes, 1, 'an unchanged offer writes nothing');
  stop();
  assert.match((await command(entry, posted, 'settings.offer', {setting: 'names', options})).error, /dynamic/);
  assert.match((await command(entry, posted, 'settings.offer', {setting: 'accounts', options: 'x'})).error, /list/);
  assert.deepEqual(readChoices('plans', 'other-connection'), {}, 'offers are kept per connection');
  // Without the permission the offer is refused.
  const plain = frameFor({permissions: ['settings']});
  assert.equal((await command(plain.entry, plain.posted, 'settings.offer', {setting: 'accounts', options})).error, 'Unknown widget command');
});

test('offered options are cleaned and capped', () => {
  const many = Array.from({length: 80}, (_, i) => ({value: 'a' + i, label: 'A' + i}));
  assert.equal(cleanOptions(many).length, 64);
  assert.deepEqual(cleanOptions([{value: '*', label: 'x'}, {value: 'ok', label: 'L\u0007abel', detail: 'd'.repeat(200)}, {value: 'ok', label: 'dup'}, {value: 'a b'}]),
    [{value: 'ok', label: 'Label', detail: 'd'.repeat(120)}]);
  assert.deepEqual(cleanOptions([{value: 'x'}]), [{value: 'x', label: 'x', detail: ''}]);
  assert.throws(() => cleanOptions(null));
});

test('Check now reaches live views of that widget and connection', async () => {
  const mine = frameFor({permissions: ['settings', 'settings.choices'], source: ''});
  const other = frameFor({permissions: ['settings', 'settings.choices'], source: 'x'});
  const plain = frameFor({permissions: ['settings'], source: ''});
  for (const f of [mine, other, plain]) await handleMessage(f.entry, {dashledge: 1, type: 'ready'});
  requestRefresh('plans', '');
  assert.equal(mine.posted.at(-1).type, 'refresh');
  assert.notEqual(other.posted.at(-1).type, 'refresh');
  assert.notEqual(plain.posted.at(-1).type, 'refresh');
});

test('declared collector commands go to the host; others are refused', async () => {
  const {entry, posted} = frameFor({permissions: []});
  invoked.length = 0;
  await command(entry, posted, 'refresh');
  assert.deepEqual(invoked.at(-1), ['widget_command', {id: 'feed-1', viewer: 'v', name: 'refresh', args: null}]);
  assert.equal((await command(entry, posted, 'reboot')).error, 'Unknown widget command');
});

test('the install sheet names the capability', () => {
  assert.ok(permissionSummary(manifest).some(line => line.includes('Lists what it finds')));
  assert.ok(permissionSummary(manifest, {permissions: ['settings']}).some(line => line.startsWith('New: Lists what it finds')));
});
