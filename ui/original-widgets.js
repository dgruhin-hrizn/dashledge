import {button, el, invoke} from './common.js';
import {titles} from './model.js';
import {packageInfo,sourceLimit} from './packages.js';
import {registerFrame} from './package-bridge.js';
import {hostOf, connectionLabel} from './display-name.js';

export function widgetSources(kind, selected, sources) {
  const limit = sourceLimit(kind);
  if (!limit) return [];
  const primary = sources.find(source => source.kind === kind && source.id === selected);
  if (!primary) return [];
  // ComfyUI's render wall pairs workers and oMLX's switcher lists every saved server,
  // up to the connection count each manifest declares.
  const endpoints = new Set();
  const guestTargets = kind === 'comfy' ? sources.filter(s => s.kind === 'proxmox')
    .flatMap(s => Object.values(s.gpuGuests || {})) : [];
  return [primary, ...sources.filter(source => source.kind === kind)]
    .filter(source => {
      const address = source.address.replace(/\/+$/, '');
      if (endpoints.has(address)) return false;
      endpoints.add(address);
      return true;
    })
    .slice(0, limit)
    .map(source => {
      // Collectors label workers and servers with this; a blank name means automatic.
      const {address, gpuGuests} = source, name = connectionLabel(source);
      if (kind === 'comfy') {
        // GPU telemetry for a worker: direct SSH from its connection, and/or the
        // Proxmox guest mapping whose host matches it.
        const host = new URL(address).hostname.toLowerCase();
        const guest = guestTargets.find(mapping => {
          const target = typeof mapping === 'string' ? mapping : mapping?.target;
          return typeof target === 'string' && target.split('@').pop().toLowerCase() === host;
        });
        const telemetry = {};
        if (guest) telemetry.worker = guest;
        if (source.gpuSsh?.target) telemetry.ssh = source.gpuSsh;
        if (Object.keys(telemetry).length) return {name, address, gpuGuests: telemetry};
      }
      return {name, address, gpuGuests};
    });
}

export function mountOriginal(box, slot, connections, {native = false, colors = null, openSettings = null} = {}) {
  const sources = widgetSources(slot.kind, slot.source, connections);
  const viewer = crypto.randomUUID();
  const info = packageInfo.get(slot.kind);
  let saved = slot.packageSettings;
  let feed, timer, closed = false, unregister = () => {};
  box.classList.add('original-widget');
  const status = el('div', 'widget-status');
  const message = el('p', '', 'Connecting to ' + titles[slot.kind] + '…');
  status.append(message);
  box.replaceChildren(status);

  function release(id) {
    if (id) invoke('widget_close', {id, viewer}).catch(() => {});
  }
  async function connect() {
    try {
      const id = await invoke('widget_open', {kind:slot.kind, sources, viewer});
      if (closed) { release(id); return; }
      feed = id;
      const frame = el('iframe', 'original-frame');
      frame.title = titles[slot.kind];
      // Package views run isolated: scripts only, no same-origin access to the app.
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.dataset.packageFrame = slot.kind;
      unregister();
      const chosen = connections.find(source => source.kind === slot.kind && source.id === slot.source);
      unregister = registerFrame(frame, {viewer, feed: id, kind: slot.kind, title: titles[slot.kind],
        commands: info?.collector?.commands || [], permissions: info?.permissions || [], schema: info?.settings || [], saved,
        source: slot.source || '', openSettings, displayName: chosen?.name?.trim() || '', host: hostOf(chosen?.address), native, colors});
      frame.src = '/widget-view/' + encodeURIComponent(id) + '/index.html';
      box.replaceChildren(frame);
      timer = setTimeout(check, 8000);
    } catch (error) {
      if (closed) return;
      message.textContent = titles[slot.kind] + ' · ' + String(error);
      box.replaceChildren(status);
      timer = setTimeout(connect, 10000);
    }
  }
  async function check() {
    const alive = await invoke('widget_ping', {id:feed, viewer}).catch(() => false);
    if (closed) return;
    if (alive) timer = setTimeout(check, 8000);
    else {
      release(feed);
      feed = undefined;
      message.textContent = 'Reconnecting to ' + titles[slot.kind] + '…';
      box.replaceChildren(status);
      timer = setTimeout(connect, 1500);
    }
  }
  if (!info?.sources || sources.length) connect();
  else {
    message.textContent = 'Choose a ' + titles[slot.kind] + ' connection in Widget Studio.';
    status.append(button('Settings', () => invoke('open_settings')));
  }
  const dispose = () => { closed = true; clearTimeout(timer); unregister(); release(feed); };
  // This placement's settings or colours changed: update the live view without reloading it.
  dispose.settings = next => { saved = next; unregister.settings?.(next); };
  dispose.colors = next => { colors = next; unregister.colors?.(next); };
  return dispose;
}

// An installed API version 2 package: its view runs sandboxed, and the app
// polls the package's declarative routes or connector and passes the data in.
export function mountPackage(box, slot, entry, connections, {native = false, openSettings = null, colors = null} = {}) {
  const viewer = crypto.randomUUID();
  let saved = slot.packageSettings;
  let feed, timer, rev = 0, closed = false, unregister = () => {};
  box.classList.add('original-widget');
  const status = el('div', 'widget-status');
  const message = el('p', '', 'Starting ' + entry.title + '…');
  status.append(message);
  box.replaceChildren(status);
  const source = connections.find(s => s.kind === slot.kind && s.id === slot.source);
  if (entry.sources?.min && !source) {
    message.textContent = 'Choose a ' + entry.title + ' connection in Widget Studio.';
    status.append(button('Settings', () => invoke('open_settings')));
    return () => {};
  }
  async function connect() {
    try {
      const opened = await invoke('package_open', {kind: slot.kind, viewer,
        connection: source ? {name: source.name, address: source.address} : null});
      if (closed) { invoke('package_close', {id: opened.id, viewer}).catch(() => {}); return; }
      feed = opened.id;
      rev = 0;
      const frame = el('iframe', 'original-frame');
      frame.title = entry.title;
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.dataset.packageFrame = slot.kind;
      unregister();
      // Permissions come from the package on disk, as the host validated it.
      unregister = registerFrame(frame, {viewer, feed, kind: slot.kind, title: entry.title, actions: entry.actions || [],
        permissions: opened.permissions || [], schema: entry.settings || [], saved, source: slot.source || '', openSettings,
        displayName: source?.name?.trim() || '', host: hostOf(source?.address), serverField: entry.serverField, native, colors});
      frame.src = '/widget-view/' + encodeURIComponent(feed) + '/' + encodeURIComponent(opened.entry);
      box.replaceChildren(frame);
      pump();
    } catch (error) {
      if (closed) return;
      message.textContent = entry.title + ' · ' + String(error);
      box.replaceChildren(status);
      timer = setTimeout(connect, 10000);
    }
  }
  async function pump() {
    try {
      const next = await invoke('package_read', {id: feed, viewer, since: rev});
      if (closed) return;
      // An unpacked package changed on disk: reopen its view and connector.
      if (next?.reload) {
        invoke('package_close', {id: feed, viewer}).catch(() => {});
        feed = null;
        return connect();
      }
      if (next) { rev = next.rev; unregister.deliver?.(next); }
      timer = setTimeout(pump, 1000);
    } catch {
      if (closed) return;
      message.textContent = 'Reconnecting to ' + entry.title + '…';
      box.replaceChildren(status);
      timer = setTimeout(connect, 1500);
    }
  }
  connect();
  const dispose = () => {
    closed = true;
    clearTimeout(timer);
    unregister();
    if (feed) invoke('package_close', {id: feed, viewer}).catch(() => {});
  };
  // This placement's settings changed: update the live view without reloading it.
  dispose.settings = next => { saved = next; unregister.settings?.(next); };
  dispose.colors = next => { colors = next; unregister.colors?.(next); };
  return dispose;
}
