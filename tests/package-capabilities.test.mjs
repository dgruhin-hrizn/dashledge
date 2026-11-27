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

test('images load only with the permission and move into the frame by transfer', async () => {
  const refused = frameFor({permissions: []});
  assert.equal((await command(refused.entry, refused.posted, 'image', {path: 'api/a.jpg'})).error, 'Unknown widget command');

  const calls = [], sent = [];
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).buffer;
  const previous = window.__TAURI__.core.invoke;
  window.__TAURI__.core.invoke = async (cmd, args) => { calls.push([cmd, args]); return jpeg; };
  try {
    const frame = new EventTarget();
    frame.contentWindow = {postMessage: (message, _origin, transfer) => sent.push({message, transfer})};
    const {entry} = registerFrame(frame, {viewer: 'v', feed: 'pkg-9', kind: 'plugin.posters', permissions: ['images']});
    frame.dispatchEvent(new Event('load'));
    await handleMessage(entry, {dashledge: 1, type: 'command', id: 3, name: 'image', args: {path: 'api/v3/mediacover/1/poster.jpg', fresh: true}});
    assert.deepEqual(calls, [['package_image', {id: 'pkg-9', viewer: 'v', path: 'api/v3/mediacover/1/poster.jpg', fresh: true}]]);
    const {message, transfer} = sent.at(-1);
    assert.equal(message.type, 'reply');
    assert.equal(message.value.type, 'image/jpeg');
    assert.equal(transfer[0], message.value.bytes, 'the bytes are transferred, not copied');
    await handleMessage(entry, {dashledge: 1, type: 'command', id: 4, name: 'image', args: {path: 'api/a.jpg', connection: 2}});
    assert.equal(calls.at(-1)[1].connection, 2, 'a view may name one of its connections');
    await handleMessage(entry, {dashledge: 1, type: 'command', id: 5, name: 'image', args: {path: 'api/a.jpg', connection: 'x'}});
    assert.equal('connection' in calls.at(-1)[1], false, 'anything but a small index means the first');
  } finally {
    window.__TAURI__.core.invoke = previous;
  }
});

test('a stream relays frames into the frame, binary ones by transfer, and closes with it', async () => {
  const refused = frameFor({permissions: []});
  assert.equal((await command(refused.entry, refused.posted, 'stream.open', {stream: 'live'})).error, 'Unknown widget command');

  const calls = [], sent = [];
  let channel = null;
  const previous = window.__TAURI__.core;
  window.__TAURI__.core = {
    Channel: class { constructor() { channel = this; this.onmessage = null; } },
    invoke: async (cmd, args) => { calls.push([cmd, args]); return cmd === 'package_stream_open' ? 41 : null; },
  };
  try {
    const frame = new EventTarget();
    frame.contentWindow = {postMessage: (message, _origin, transfer) => sent.push({message, transfer})};
    const registered = registerFrame(frame, {viewer: 'v', feed: 'pkg-3', kind: 'plugin.cameras', permissions: ['stream']});
    frame.dispatchEvent(new Event('load'));
    const entry = registered.entry;
    await handleMessage(entry, {dashledge: 1, type: 'command', id: 1, name: 'stream.open', args: {stream: 'live', params: {camera: 'front', bad: {x: 1}}}});
    assert.deepEqual(calls[0].slice(0, 1), ['package_stream_open']);
    assert.deepEqual(calls[0][1].params, {camera: 'front'}, 'only string and number params pass');
    assert.equal(sent.at(-1).message.value, 41);
    const segment = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]).buffer;
    channel.onmessage({event: 'open'});
    channel.onmessage(segment);
    const [open, binary] = sent.slice(-2);
    assert.deepEqual([open.message.type, open.message.stream, open.message.event], ['stream', 41, 'open']);
    assert.equal(binary.message.event, 'binary');
    assert.equal(binary.transfer[0], segment, 'video segments move by transfer');
    await handleMessage(entry, {dashledge: 1, type: 'command', id: 2, name: 'stream.send', args: {stream: 41, text: '{"type":"mse"}'}});
    assert.deepEqual(calls.at(-1), ['package_stream_send', {id: 'pkg-3', viewer: 'v', stream: 41, text: '{"type":"mse"}'}]);
    await handleMessage(entry, {dashledge: 1, type: 'command', id: 3, name: 'stream.send', args: {stream: 99, text: 'x'}});
    assert.equal(sent.at(-1).message.error, 'That stream is closed', 'a view can only use streams it opened');
    registered();
    assert.deepEqual(calls.at(-1), ['package_stream_close', {id: 'pkg-3', viewer: 'v', stream: 41}], 'removing the frame closes its streams');
  } finally {
    window.__TAURI__.core = previous;
  }
});

test('the install sheet names the images capability', () => {
  assert.ok(permissionSummary({permissions: ['images'], images: ['api/*.jpg']}).some(line => line.includes('images from that connection')));
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
