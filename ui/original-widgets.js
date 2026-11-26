import {button, el, invoke} from './common.js';
import {titles} from './model.js';
import {packageInfo,sourceLimit} from './packages.js';
import {registerFrame} from './package-bridge.js';

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
    .map(({name, address, gpuGuests}) => {
      if (kind === 'comfy' && guestTargets.length) {
        const host = new URL(address).hostname.toLowerCase();
        const guest = guestTargets.find(mapping => {
          const target = typeof mapping === 'string' ? mapping : mapping?.target;
          return typeof target === 'string' && target.split('@').pop().toLowerCase() === host;
        });
        if (guest) return {name, address, gpuGuests:{worker:guest}};
      }
      return {name, address, gpuGuests};
    });
}

export function mountOriginal(box, slot, connections) {
  const sources = widgetSources(slot.kind, slot.source, connections);
  const viewer = crypto.randomUUID();
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
      unregister = registerFrame(frame, {viewer, feed: id, commands: packageInfo.get(slot.kind)?.collector?.commands || []});
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
  if (!packageInfo.get(slot.kind)?.sources || sources.length) connect();
  else {
    message.textContent = 'Choose a ' + titles[slot.kind] + ' connection in Widget Studio.';
    status.append(button('Settings', () => invoke('open_settings')));
  }
  return () => { closed = true; clearTimeout(timer); unregister(); release(feed); };
}
