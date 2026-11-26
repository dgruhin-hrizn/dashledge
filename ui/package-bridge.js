// Host side of the package bridge. Package views run in sandboxed frames; this
// module is the only way they reach Dashledge. A message counts only when its
// source is a registered frame's window, and a command runs only when that
// frame's package declares it.
import {invoke} from './common.js';
import {general, onGeneral} from './general.js';

const frames = new Map(); // contentWindow → entry

export function packageState(entry) {
  const prefs = general();
  return {
    // The oMLX view keys its model actions by this ID; the host formats the same one.
    instanceID: 'omlx-dashboard@' + entry.viewer,
    touchMode: false,
    displayName: entry.displayName || '',
    theme: {mode: 'dark', primary: prefs.primary || '#edf0e6', accent: prefs.accent || '#f88d4f'},
  };
}

function post(entry, message) {
  entry.frame.contentWindow?.postMessage({dashledge: 1, ...message}, '*');
}

// Track a package frame. `commands` lists the commands its manifest declares.
export function registerFrame(frame, {viewer, feed, commands = [], displayName = ''}) {
  const entry = {frame, viewer, feed, commands, displayName, window: null};
  frame.addEventListener('load', () => {
    for (const [win, other] of frames) if (other === entry) frames.delete(win);
    entry.window = frame.contentWindow;
    if (entry.window) frames.set(entry.window, entry);
  });
  return () => { if (entry.window) frames.delete(entry.window); };
}

export async function handleMessage(entry, message) {
  switch (message.type) {
    case 'ready':
      post(entry, {type: 'state', state: packageState(entry)});
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
      if (message.name !== 'model' || !entry.commands.includes('model'))
        return reply(undefined, 'Unknown widget command');
      try {
        reply(await invoke('widget_model_action', {id: entry.feed, viewer: entry.viewer, command: message.args}));
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
