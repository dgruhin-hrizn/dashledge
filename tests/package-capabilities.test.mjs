import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// A minimal browser surface for the host bridge.
globalThis.window = new EventTarget();
globalThis.window.__TAURI__ = {core: {invoke: async () => 'done'}};
globalThis.localStorage = {store: {}, getItem(k) { return this.store[k] ?? null; }, setItem(k, v) { this.store[k] = String(v); }};
globalThis.CustomEvent ??= class extends Event { constructor(type, init) { super(type); this.detail = init?.detail; } };
const {registerFrame, handleMessage, packageState, publicMetrics, deliverMetrics} = await import('../ui/package-bridge.js');
const {settingValues} = await import('../ui/package-settings.js');
const {permissionSummary} = await import('../ui/package-manifest.js');
const {packageEntry} = await import('../ui/widget-catalog.js');

const fixture = JSON.parse(await readFile(new URL('./fixtures/capabilities-package/widget.json', import.meta.url), 'utf8'));
// Rust fills each setting's default; the fixture leaves the choice's out.
const schema = fixture.settings.map(s => s.id === 'metric' ? {...s, default: 'cpu'} : s);

function frameFor(options) {
  const posted = [];
  const frame = new EventTarget();
  frame.contentWindow = {postMessage: message => posted.push(message)};
  const unregister = registerFrame(frame, {viewer: 'v', feed: 'pkg-1', kind: 'plugin.capabilities-demo', title: 'Capabilities demo', ...options});
  frame.dispatchEvent(new Event('load'));
  return {entry: unregister.entry, posted, unregister};
}
const command = async (entry, posted, name, args) => {
  await handleMessage(entry, {dashledge: 1, type: 'command', id: 7, name, args});
  return posted.at(-1);
};

test('a placement resolves saved settings against the schema', () => {
  assert.deepEqual(settingValues(schema, {}), {label: 'This Mac', metric: 'cpu', precision: 1, trace: true});
  assert.deepEqual(settingValues(schema, {label: 'Studio', metric: 'gpu', precision: 7, trace: 'yes', stray: 1}),
    {label: 'Studio', metric: 'cpu', precision: 1, trace: true}, 'values outside the schema fall back to defaults');
  assert.equal(settingValues(schema, {label: 'a\u0007b'}).label, 'ab');
  assert.equal(settingValues(schema, {label: 'x'.repeat(41)}).label, 'This Mac', 'text longer than maxLength is refused');
});

test('two placements keep their own settings', () => {
  const page = {slots: [{id: 'a', kind: 'plugin.capabilities-demo'}, {id: 'b', kind: 'plugin.capabilities-demo', packageSettings: {metric: 'memory'}}]};
  page.slots[0] = {...page.slots[0], packageSettings: settingValues(schema, {metric: 'network', precision: 2})};
  assert.equal(settingValues(schema, page.slots[0].packageSettings).metric, 'network');
  assert.equal(settingValues(schema, page.slots[1].packageSettings).metric, 'memory');
  assert.equal(settingValues(schema, page.slots[1].packageSettings).precision, 1);
});

test('settings reach the view in its state and update live', async () => {
  const {entry, posted, unregister} = frameFor({permissions: ['settings'], schema, saved: {metric: 'memory'}});
  await handleMessage(entry, {dashledge: 1, type: 'ready'});
  assert.equal(posted.at(-1).state.settings.metric, 'memory');
  unregister.settings({metric: 'network'});
  assert.equal(posted.at(-1).type, 'state');
  assert.equal(posted.at(-1).state.settings.metric, 'network');
  assert.equal(packageState(frameFor({schema}).entry).settings, undefined, 'no settings without the permission');
});

test('undeclared capabilities are refused', async () => {
  const {entry, posted} = frameFor({permissions: [], schema, openSettings: async () => ({})});
  for (const name of ['settings.open', 'keyboard.open', 'mac.metrics', 'mac.subscribe'])
    assert.equal((await command(entry, posted, name, {})).error, 'Unknown widget command', name);
  const declared = frameFor({permissions: ['settings']});
  assert.equal((await command(declared.entry, declared.posted, 'settings.open')).error, 'Unknown widget command',
    'settings.open needs an editor to open');
});

test('the settings gear opens the placement editor', async () => {
  const {entry, posted} = frameFor({permissions: ['settings'], schema, openSettings: async () => ({metric: 'cpu'})});
  const reply = await command(entry, posted, 'settings.open');
  assert.deepEqual(reply.value, {metric: 'cpu'});
});

test('Mac metrics carry only the documented fields', async () => {
  const raw = {cpu: 12.5, perCore: [10, 15], cores: 2, gpu: null, memory: 8, capacity: 16, swap: 0, rx: 1000, tx: 2000,
    uptime: 90, model: 'Apple M4 Max', host: 'private-hostname', disks: [{name: 'Secret volume'}], interfaces: [{name: 'en0'}],
    history: [{at: 42}]};
  const metrics = publicMetrics(raw);
  assert.deepEqual(metrics, {at: 42, cpu: 12.5, perCore: [10, 15], cores: 2, gpu: null, memory: {used: 8, total: 16, swap: 0},
    network: {rx: 1000, tx: 2000}, uptime: 90, chip: 'Apple M4 Max'});
  assert.ok(!JSON.stringify(metrics).includes('private-hostname'));

  const subscribed = frameFor({permissions: ['mac.metrics']}), bystander = frameFor({permissions: []});
  for (const f of [subscribed, bystander]) await handleMessage(f.entry, {dashledge: 1, type: 'ready'});
  await command(subscribed.entry, subscribed.posted, 'mac.subscribe');
  await command(bystander.entry, bystander.posted, 'mac.subscribe');
  const before = bystander.posted.length;
  deliverMetrics(raw);
  assert.deepEqual(subscribed.posted.at(-1), {dashledge: 1, type: 'metrics', metrics});
  assert.equal(bystander.posted.length, before, 'frames without mac.metrics get nothing');
  assert.deepEqual((await command(subscribed.entry, subscribed.posted, 'mac.metrics')).value, metrics);
});

test('the install sheet lists capabilities and marks new ones on update', () => {
  const lines = permissionSummary(fixture);
  assert.ok(lines.includes('Has settings you choose for each placement.'));
  assert.ok(lines.includes('Can open the on-screen keyboard to ask you for text.'));
  assert.ok(lines.some(line => line.startsWith('Reads this Mac')));
  const update = permissionSummary(fixture, {permissions: ['settings']});
  assert.ok(update.includes('New: Can open the on-screen keyboard to ask you for text.'));
  assert.ok(update.includes('Has settings you choose for each placement.'));
});

test('the catalog entry carries permissions and settings to the dashboard', () => {
  const entry = packageEntry({...fixture, settings: schema, tier: 'view'});
  assert.deepEqual(entry.permissions, ['settings', 'keyboard', 'ui', 'mac.metrics']);
  assert.equal(entry.settings.length, 4);
});

test('Reminders reach only views that declare them, with checked arguments', async () => {
  const calls = [];
  const original = window.__TAURI__.core.invoke;
  window.__TAURI__.core.invoke = async (name, args) => { calls.push([name, args]); return {permission: 'allowed', items: []}; };
  try {
    const bystander = frameFor({permissions: []});
    for (const name of ['reminders.read', 'reminders.complete', 'reminders.add', 'reminders.privacy'])
      assert.equal((await command(bystander.entry, bystander.posted, name, {})).error, 'Unknown widget command', name);
    assert.equal(calls.length, 0, 'nothing reaches EventKit without the permission');

    const {entry, posted} = frameFor({permissions: ['reminders']});
    assert.deepEqual((await command(entry, posted, 'reminders.read', {request: 'yes'})).value, {permission: 'allowed', items: []});
    assert.deepEqual(calls.at(-1), ['reminders_read', {request: false}], 'only a literal true asks macOS');
    await command(entry, posted, 'reminders.read', {request: true});
    assert.deepEqual(calls.at(-1), ['reminders_read', {request: true}]);

    assert.equal((await command(entry, posted, 'reminders.complete', {id: 7, completed: true})).error, 'Error: Choose a reminder');
    await command(entry, posted, 'reminders.complete', {id: 'ABC-1', completed: false});
    assert.deepEqual(calls.at(-1), ['reminders_complete', {id: 'ABC-1', completed: false}]);

    assert.equal((await command(entry, posted, 'reminders.add', {title: '   '})).error, 'Error: Type a reminder first');
    await command(entry, posted, 'reminders.add', {title: 'x'.repeat(400)});
    assert.deepEqual(calls.at(-1), ['reminders_create', {title: 'x'.repeat(400), list: null}], 'Rust caps the length by character');
    await command(entry, posted, 'reminders.add', {title: 'Milk', list: 'LIST-1'});
    assert.deepEqual(calls.at(-1), ['reminders_create', {title: 'Milk', list: 'LIST-1'}]);
  } finally {
    window.__TAURI__.core.invoke = original;
  }
  assert.ok(permissionSummary({permissions: ['reminders']}).some(line => line.includes('Apple Reminders')));
});
