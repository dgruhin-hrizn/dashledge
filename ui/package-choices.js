// Options a package view finds at run time for its `dynamic` settings (the
// `settings.choices` capability), such as the accounts on this Mac. The bridge stores
// what a view offers here, per widget and connection, so the settings editor in any
// window lists them even when no view of that widget is on screen. Check now asks
// every live view of that widget and connection to look again.

const KEY = 'edge.packageChoices';
const REFRESH = 'edge.packageChoicesRefresh';
const CHANGED = 'packagechoices';
// Mirrors choice_value() and MAX_CHOICES in src-tauri/package-core/src/manifest.rs.
export const CHOICE_VALUE = /^[A-Za-z0-9._:@/-]{1,128}$/;
export const MAX_CHOICES = 64;

const clean = (value, limit) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit);
const slotKey = (kind, source) => kind + '|' + (source || '');

// What a view offered, as the editor may show it: at most 64 options, each with a
// plain value, a label and an optional detail line, every one plain text.
export function cleanOptions(list) {
  if (!Array.isArray(list)) throw new Error('Offer a list of options');
  const seen = new Set(), out = [];
  for (const option of list.slice(0, MAX_CHOICES)) {
    const value = typeof option?.value === 'string' ? option.value : '';
    if (!CHOICE_VALUE.test(value) || seen.has(value)) continue;
    seen.add(value);
    out.push({value, label: clean(option.label, 64) || value, detail: clean(option.detail, 120)});
  }
  return out;
}

function readAll() {
  try {
    const all = JSON.parse(localStorage.getItem(KEY));
    return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
  } catch { return {}; }
}

// The latest options for each dynamic setting of this widget and connection: {setting: [...]}.
export function readChoices(kind, source) {
  const saved = readAll()[slotKey(kind, source)] || {};
  const out = {};
  for (const [setting, entry] of Object.entries(saved)) out[setting] = Array.isArray(entry?.options) ? entry.options : [];
  return out;
}

// Store a view's offer. Unchanged offers write nothing, so open editors aren't redrawn.
export function storeChoices(kind, source, setting, options) {
  const all = readAll(), key = slotKey(kind, source);
  const before = JSON.stringify(all[key]?.[setting]?.options);
  if (before === JSON.stringify(options)) return false;
  all[key] = {...all[key], [setting]: {at: Date.now(), options}};
  localStorage.setItem(KEY, JSON.stringify(all));
  window.dispatchEvent(new Event(CHANGED));
  return true;
}

// Call `callback` when any window stores new options. Returns unsubscribe.
export function watchChoices(callback) {
  const onStorage = e => { if (e.key === KEY) callback(); };
  window.addEventListener('storage', onStorage);
  window.addEventListener(CHANGED, callback);
  return () => { window.removeEventListener('storage', onStorage); window.removeEventListener(CHANGED, callback); };
}

// Check now: ask live views of this widget and connection, in every window, to look again.
export function requestRefresh(kind, source) {
  const request = {kind, source: source || '', at: Date.now()};
  localStorage.setItem(REFRESH, JSON.stringify(request));
  window.dispatchEvent(new CustomEvent(REFRESH, {detail: request}));
}

// The bridge's side of requestRefresh.
export function onRefreshRequest(callback) {
  const run = request => { if (request && typeof request.kind === 'string') callback(request.kind, request.source || ''); };
  window.addEventListener('storage', e => {
    if (e.key !== REFRESH || !e.newValue) return;
    try { run(JSON.parse(e.newValue)); } catch {}
  });
  window.addEventListener(REFRESH, e => run(e.detail));
}
