// Host side of the package bridge. Package views run in sandboxed frames; this
// module is the only way they reach Dashledge. A message counts only when its
// source is a registered frame's window, and a command runs only when that
// frame's package declares it.
import {invoke} from './common.js';
import {general, onGeneral} from './general.js';
import {openTouchKeyboard} from './search-keyboard.js';
import {settingValues} from './package-settings.js';

const frames = new Map(); // contentWindow → entry
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
    theme: {mode: 'dark', primary: prefs.primary || '#edf0e6', accent: prefs.accent || '#f88d4f'},
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

// Track a package frame. `commands` lists the collector commands and `permissions`
// the capabilities its manifest declares; `schema` is its settings and `saved` this
// placement's stored values. `openSettings()` opens this placement's settings editor.
// Returns unregister(); `deliver(data)` sends a package feed's data, now or once ready,
// and `settings(saved)` sends the placement's changed settings to the live view.
export function registerFrame(frame, {viewer, feed, kind = '', title = '', commands = [], actions = [], permissions = [],
  schema = [], saved = {}, openSettings = null, displayName = '', host = '', serverField = '', native = false}) {
  const entry = {frame, viewer, feed, kind, title: clean(title, 64) || 'Widget', commands, actions, permissions, schema,
    settings: settingValues(schema, saved), openSettings, displayName, host, serverField, native,
    serverName: '', window: null, data: null, ready: false, metrics: false, keyboard: null};
  frame.addEventListener('load', () => {
    for (const [win, other] of frames) if (other === entry) frames.delete(win);
    entry.window = frame.contentWindow;
    entry.ready = false;
    entry.metrics = false;
    if (entry.window) frames.set(entry.window, entry);
  });
  const unregister = () => {
    if (entry.window) frames.delete(entry.window);
    entry.keyboard?.dialog.close();
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
    const entry = frames.get(event.source);
    if (!entry || event.data?.dashledge !== 1) return;
    handleMessage(entry, event.data);
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
