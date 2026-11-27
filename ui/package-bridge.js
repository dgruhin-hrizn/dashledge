// Host side of the package bridge. Package views run in sandboxed frames; this
// module is the only way they reach Dashledge. A message counts only when its
// source is a registered frame's window, and a command runs only when that
// frame's package declares it.
import {invoke} from './common.js';
import {general, onGeneral} from './general.js';
import {openTouchKeyboard} from './search-keyboard.js';
import {settingValues} from './package-settings.js';
import {placementColors} from './placement-colors.js';
import {cleanOptions, onRefreshRequest, storeChoices} from './package-choices.js';

const frames = new Map(); // contentWindow → entry
// Every registered frame. A view's SDK says `ready` while its document is still
// loading, before the frame's load event, so the first message is matched here.
const entries = new Set();
let latestMetrics = null;
const clean = (value, limit) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit);
const readField = (data, path) => path.split('.').reduce((v, k) => v != null && Object.hasOwn(v, k) ? v[k] : undefined, data);

export function packageState(entry) {
  const prefs = general();
  return {
    // The oMLX view keys its model actions by this ID; the host formats the same one.
    instanceID: 'omlx-dashboard@' + entry.viewer,
    touchMode: false,
    // The name the user gave the connection ('' means automatic), what the server
    // reports about itself when the manifest says where, and the address's host.
    displayName: entry.displayName || '',
    serverName: entry.serverName || '',
    host: entry.host || '',
    // 'native' when the widget fills the display at its real size; 'reference' in a
    // split page's 1920 × 540 canvas.
    viewport: entry.native ? 'native' : 'reference',
    // General colours, or this placement's own when it overrides them.
    theme: {mode: 'dark', ...placementColors({colors: entry.colors}, prefs)},
    // The capabilities the manifest declares, and this placement's settings.
    permissions: [...(entry.permissions || [])],
    ...(granted(entry, 'settings') ? {settings: {...entry.settings}} : {}),
  };
}

const granted = (entry, permission) => !!entry.permissions?.includes(permission);
// A package may raise a sheet only while its frame is on the displayed page.
const onScreen = entry => typeof document === 'undefined' ||
  (!document.hidden && entry.frame.isConnected !== false && !entry.frame.closest?.('[hidden]'));

// The documented subset of read_metrics that `mac.metrics` packages receive. Fields are
// copied one by one, so volume names, interfaces and the host name stay private.
export function publicMetrics(raw) {
  if (!raw) return null;
  const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  return {
    at: number(raw.history?.at?.(-1)?.at) ?? Date.now(),
    cpu: number(raw.cpu),
    perCore: Array.isArray(raw.perCore) ? raw.perCore.map(number) : [],
    cores: number(raw.cores),
    gpu: number(raw.gpu),
    memory: {used: number(raw.memory), total: number(raw.capacity), swap: number(raw.swap)},
    network: {rx: number(raw.rx), tx: number(raw.tx)},
    uptime: number(raw.uptime),
    chip: typeof raw.model === 'string' ? raw.model.slice(0, 80) : null,
  };
}

// The dashboard's metrics poll hands each fresh sample here.
export function deliverMetrics(raw) {
  latestMetrics = publicMetrics(raw);
  for (const entry of frames.values())
    if (entry.ready && entry.metrics && granted(entry, 'mac.metrics')) post(entry, {type: 'metrics', metrics: latestMetrics});
}

// The shared touch keyboard, branded with the package's own title so a view can't
// pass itself off as Dashledge or another widget. One sheet per frame.
function openKeyboard(entry, options = {}) {
  if (entry.keyboard) return Promise.reject(new Error('The keyboard is already open'));
  const maxLength = Math.min(1024, Math.max(1, Math.floor(Number(options.maxLength)) || 256));
  return new Promise(resolve => {
    const sheet = openTouchKeyboard({
      title: clean(options.title, 80) || entry.title,
      brand: entry.title,
      icon: '/widget-icon/' + encodeURIComponent(entry.kind),
      placeholder: clean(options.placeholder, 80) || 'Type here',
      actionLabel: clean(options.actionLabel, 16) || 'Done',
      maxLength,
      onSubmit: () => { finish(sheet.input.value); sheet.dialog.close(); },
    });
    sheet.input.value = clean(options.value, maxLength);
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      entry.keyboard = null;
      resolve(value == null ? null : clean(value, maxLength));
    };
    sheet.dialog.addEventListener('close', () => finish(null));
    entry.keyboard = sheet;
  });
}

function post(entry, message) {
  entry.frame.contentWindow?.postMessage({dashledge: 1, ...message}, '*');
}

function track(entry, win) {
  if (!win || entry.window === win) return;
  if (entry.window) frames.delete(entry.window);
  entry.window = win;
  frames.set(win, entry);
}
// The registered frame a message came from, before its load event mapped it.
function claim(source) {
  for (const entry of entries) if (source && entry.frame.contentWindow === source) { track(entry, source); return entry; }
  return null;
}

// The voice settings a view may send, field by field; Rust checks the values again.
function voiceSettings(value) {
  const v = value && typeof value === 'object' ? value : {};
  const bool = key => v[key] === true;
  const num = (key, fallback) => typeof v[key] === 'number' && Number.isFinite(v[key]) ? v[key] : fallback;
  return {enabled: bool('enabled'), muted: bool('muted'), lead: Math.max(0, Math.round(num('lead', 0))), quiet: bool('quiet'),
    quietStart: Math.max(0, Math.round(num('quietStart', 1320))), quietEnd: Math.max(0, Math.round(num('quietEnd', 420))),
    volume: num('volume', 0.8), voice: typeof v.voice === 'string' ? v.voice.slice(0, 200) : ''};
}

// Apple Reminders for bundled views that declare `reminders`. Asking macOS for access,
// changing reminders and changing the voice happen only while the widget is on screen.
async function reminders(entry, name, args) {
  const visible = onScreen(entry);
  if (name === 'reminders.read') return invoke('reminders_read', {request: args.request === true && visible});
  if (name === 'reminders.changes') return invoke('reminders_changes');
  if (name === 'reminders.voice') return invoke('reminders_voice');
  if (!visible) throw new Error('Reminders change only while the widget is on screen');
  if (name === 'reminders.complete') {
    if (typeof args.id !== 'string' || typeof args.completed !== 'boolean') throw new Error('Choose a reminder');
    return invoke('reminders_complete', {id: args.id, completed: args.completed});
  }
  if (name === 'reminders.add') {
    if (typeof args.title !== 'string' || !args.title.trim()) throw new Error('Type a reminder first');
    const text = key => typeof args[key] === 'string' ? args[key] : '';
    const priority = [1, 5, 9].includes(args.priority) ? args.priority : 0;
    // Rust trims and caps the title by character and checks the date and time.
    return invoke('reminders_create', {title: args.title, list: text('list') || null, due: text('due') || null, time: text('time') || null, priority});
  }
  if (name === 'reminders.voice.set') return invoke('reminders_voice_set', {settings: voiceSettings(args.settings)});
  if (name === 'reminders.voice.more') return invoke('reminders_voice_more');
  if (name === 'reminders.voice.test') return invoke('reminders_voice_test', args.settings ? {settings: voiceSettings(args.settings)} : {});
  if (name === 'reminders.privacy') return invoke('reminders_privacy');
  throw new Error('Unknown widget command');
}

// Track a package frame. `commands` lists the collector commands and `permissions`
// the capabilities its manifest declares; `schema` is its settings and `saved` this
// placement's stored values; `source` is its connection ID, which keys the options a
// `settings.choices` view offers. `openSettings()` opens this placement's settings editor.
// Returns unregister(); `deliver(data)` sends a package feed's data, now or once ready,
// and `settings(saved)` sends the placement's changed settings to the live view.
export function registerFrame(frame, {viewer, feed, kind = '', title = '', commands = [], actions = [], permissions = [],
  schema = [], saved = {}, source = '', openSettings = null, colors = null, displayName = '', host = '', serverField = '', native = false}) {
  const entry = {frame, viewer, feed, kind, title: clean(title, 64) || 'Widget', commands, actions, permissions, schema, source,
    settings: settingValues(schema, saved), openSettings, colors, displayName, host, serverField, native,
    serverName: '', window: null, data: null, ready: false, metrics: false, keyboard: null};
  entries.add(entry);
  // Readiness comes from the view's `ready`, which each new document sends; load fires
  // after it, so it only maps the window.
  frame.addEventListener('load', () => track(entry, frame.contentWindow));
  const unregister = () => {
    entries.delete(entry);
    if (entry.window) frames.delete(entry.window);
    entry.keyboard?.dialog.close();
  };
  unregister.colors = next => {
    entry.colors = next || null;
    if (entry.ready) post(entry, {type: 'state', state: packageState(entry)});
  };
  unregister.settings = next => {
    entry.settings = settingValues(entry.schema, next);
    if (entry.ready && granted(entry, 'settings')) post(entry, {type: 'state', state: packageState(entry)});
  };
  unregister.deliver = data => {
    entry.data = data;
    const reported = entry.serverField ? readField(data.data, entry.serverField) : '';
    if (typeof reported === 'string' && reported.trim() && reported.trim() !== entry.serverName) {
      entry.serverName = reported.trim().slice(0, 80);
      if (entry.ready) post(entry, {type: 'state', state: packageState(entry)});
    }
    if (entry.ready) post(entry, {type: 'data', ...data});
  };
  unregister.entry = entry;
  return unregister;
}

export async function handleMessage(entry, message) {
  switch (message.type) {
    case 'ready':
      entry.ready = true;
      entry.metrics = false;
      post(entry, {type: 'state', state: packageState(entry)});
      if (entry.data) post(entry, {type: 'data', ...entry.data});
      return;
    case 'gesture':
      entry.frame.__gestureVerdict = message.page === true;
      return;
    case 'swipe':
      if (message.step === 1 || message.step === -1)
        window.dispatchEvent(new CustomEvent('edgepageswipe', {detail: message.step}));
      return;
    case 'pagepicker':
      window.dispatchEvent(new CustomEvent('edgepagepicker'));
      return;
    case 'focus-window':
      invoke('focus_window').catch(() => {});
      return;
    case 'command': {
      const reply = (value, error) => post(entry, {type: 'reply', id: message.id, value, error});
      try {
        if (message.name === 'model' && entry.commands.includes('model'))
          return reply(await invoke('widget_model_action', {id: entry.feed, viewer: entry.viewer, command: message.args}));
        // Any other collector command the manifest declares; the host checks it again.
        if (entry.commands.includes(message.name))
          return reply(await invoke('widget_command', {id: entry.feed, viewer: entry.viewer, name: message.name, args: message.args ?? null}));
        // A declarative action: the host checks it against the manifest again.
        if (message.name === 'action' && entry.actions.includes(message.args?.id)) {
          const args = message.args.args && typeof message.args.args === 'object' ? message.args.args : {};
          return reply(await invoke('package_action', {id: entry.feed, viewer: entry.viewer, action: message.args.id, args}));
        }
        // Capabilities, each only when the manifest declares it.
        if (message.name === 'settings.open' && granted(entry, 'settings') && entry.openSettings) {
          if (!onScreen(entry)) return reply(undefined, 'Settings open only while the widget is on screen');
          return reply(await entry.openSettings());
        }
        if (message.name === 'keyboard.open' && granted(entry, 'keyboard')) {
          if (!onScreen(entry)) return reply(undefined, 'The keyboard opens only while the widget is on screen');
          return reply(await openKeyboard(entry, message.args && typeof message.args === 'object' ? message.args : {}));
        }
        // Options for one of the package's own dynamic settings, kept for the settings editor.
        if (message.name === 'settings.offer' && granted(entry, 'settings.choices')) {
          const setting = entry.schema.find(item => item.id === message.args?.setting && item.dynamic);
          if (!setting) return reply(undefined, 'Not a dynamic setting');
          storeChoices(entry.kind, entry.source, setting.id, cleanOptions(message.args.options));
          return reply(true);
        }
        if (message.name.startsWith('reminders.') && granted(entry, 'reminders'))
          return reply(await reminders(entry, message.name, message.args && typeof message.args === 'object' ? message.args : {}));
        if (message.name === 'mac.metrics' && granted(entry, 'mac.metrics')) return reply(latestMetrics);
        if (message.name === 'mac.subscribe' && granted(entry, 'mac.metrics')) {
          entry.metrics = true;
          return reply(latestMetrics);
        }
        reply(undefined, 'Unknown widget command');
      } catch (error) {
        reply(undefined, String(error));
      }
    }
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('message', event => {
    if (event.data?.dashledge !== 1) return;
    const entry = frames.get(event.source) || claim(event.source);
    if (!entry) return;
    handleMessage(entry, event.data);
  });
  // Check now in a settings editor, in this window or another: ask the live views of
  // that widget and connection to look again.
  onRefreshRequest((kind, source) => {
    for (const entry of entries)
      if (entry.ready && entry.kind === kind && entry.source === source && granted(entry, 'settings.choices')) post(entry, {type: 'refresh'});
  });
  // Theme changes reach every package view.
  onGeneral(() => {
    for (const entry of frames.values()) post(entry, {type: 'state', state: packageState(entry)});
  });
}

// The page holding these frames was hidden.
export function blurFrames(root) {
  for (const frame of root?.querySelectorAll('iframe') || []) {
    const entry = frames.get(frame.contentWindow);
    if (entry) post(entry, {type: 'blur'});
    else if (frame.contentDocument) frame.contentWindow.dispatchEvent(new frame.contentWindow.Event('blur'));
  }
}

export const isPackageWindow = win => frames.has(win);
