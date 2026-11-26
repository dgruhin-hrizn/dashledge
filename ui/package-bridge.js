// Host side of the package bridge. Package views run in sandboxed frames; this
// module is the only way they reach Dashledge. A message counts only when its
// source is a registered frame's window, and a command runs only when that
// frame's package declares it.
import {invoke} from './common.js';
import {general, onGeneral} from './general.js';

const frames = new Map(); // contentWindow → entry
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
  };
}

function post(entry, message) {
  entry.frame.contentWindow?.postMessage({dashledge: 1, ...message}, '*');
}

// Track a package frame. `commands` lists the commands its manifest declares.
// Returns unregister(); `deliver(data)` sends a package feed's data, now or once ready.
export function registerFrame(frame, {viewer, feed, commands = [], actions = [], displayName = '', host = '', serverField = '', native = false}) {
  const entry = {frame, viewer, feed, commands, actions, displayName, host, serverField, native, serverName: '', window: null, data: null, ready: false};
  frame.addEventListener('load', () => {
    for (const [win, other] of frames) if (other === entry) frames.delete(win);
    entry.window = frame.contentWindow;
    entry.ready = false;
    if (entry.window) frames.set(entry.window, entry);
  });
  const unregister = () => { if (entry.window) frames.delete(entry.window); };
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
