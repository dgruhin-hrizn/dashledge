import {button, el, invoke} from './common.js';
import {titles} from './model.js';

export function widgetSources(kind, selected, sources) {
  if (kind === 'ember') return [];
  const primary = sources.find(source => source.kind === kind && source.id === selected);
  if (!primary) return [];
  // The original render wall pairs workers. The oMLX switcher lists all saved servers.
  const limit = kind === 'comfy' ? 2 : kind === 'omlx' ? 20 : 1;
  const endpoints = new Set();
  return [primary, ...sources.filter(source => source.kind === kind)]
    .filter(source => {
      const address = source.address.replace(/\/+$/, '');
      if (endpoints.has(address)) return false;
      endpoints.add(address);
      return true;
    })
    .slice(0, limit)
    .map(({name, address, gpuGuests}) => ({name, address, gpuGuests}));
}

export function mountOriginal(box, slot, connections) {
  const sources = widgetSources(slot.kind, slot.source, connections);
  const viewer = crypto.randomUUID();
  let feed, timer, closed = false;
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
      frame.dataset.viewer = viewer;
      frame.sendModelAction = command => invoke('widget_model_action', {id, viewer, command});
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
  if (slot.kind === 'ember' || sources.length) connect();
  else {
    message.textContent = 'Choose a ' + titles[slot.kind] + ' connection in Pages & layouts.';
    status.append(button('Settings', () => invoke('open_settings')));
  }
  return () => { closed = true; clearTimeout(timer); release(feed); };
}
