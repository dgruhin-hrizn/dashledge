// Per-placement colours. General settings choose the text and highlight colours every
// widget follows; a placement may override either for itself, saved on its slot as
// `colors: {primary?, accent?}`. A missing value keeps following General.
const HEX = /^#[0-9a-f]{6}$/i;
const clean = value => typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : null;

// Built-in widgets with a palette of their own (artwork, brand or provider colours).
// Mail & Calendar colours each pane itself, so General and an override can't reach it.
const ownPalette = new Set(['applemusic', 'spotify', 'markets', 'photos', 'shortcuts', 'rundmd', 'googledesk', 'empty']);

// Does this widget follow the General colours, and so take a per-placement override?
// Packages say so in their manifest (`view.theme`); built-in tiles follow them unless
// they carry their own palette.
export function followsColors(kind, {slack = false, custom = null, bundled = null} = {}) {
  if (slack) return false;
  if (bundled) return !!bundled.view?.theme;
  if (custom?.apiVersion === 2) return !!custom.theme;
  return !ownPalette.has(kind);
}

// The override to save: only valid colours that differ from General.
export function placementOverride(colors, general = {}) {
  const out = {};
  for (const key of ['primary', 'accent']) {
    const value = clean(colors?.[key]);
    if (value && value !== clean(general[key])) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

// The colours a placement shows: its override, else General.
export function placementColors(slot, general = {}) {
  return {
    primary: clean(slot?.colors?.primary) || general.primary || '#edf0e6',
    accent: clean(slot?.colors?.accent) || general.accent || '#f88d4f',
  };
}

// Curated choices for the placement panel. `null` follows General.
export const HIGHLIGHTS = [['Lime', '#c4f38f'], ['Mint', '#7ee0b5'], ['Teal', '#4fd1c5'], ['Sky', '#7cc4ff'], ['Iris', '#a99cff'],
  ['Rose', '#ff8fb1'], ['Coral', '#ff7a6b'], ['Amber', '#ffc566'], ['Sand', '#e2c9a0'], ['Slate', '#9aa7b0']];
export const TEXTS = [['Warm', '#f6ecd9'], ['Cool', '#e3edf7'], ['Soft', '#b9c2bb']];

// Live preview while a placement is being edited. The settings window writes the
// draft (colours and package settings) here; the dashboard shows it on that one
// placement without saving it, and drops it when the key goes away. A stale preview
// (editor closed abnormally) expires.
export const PREVIEW_KEY = 'edge.placementPreview';
const PREVIEW_TTL = 10 * 60 * 1000;
export function writePreview(slot, {colors = null, packageSettings} = {}) {
  const value = {slot, colors: placementOverride(colors) || {}, at: Date.now()};
  if (packageSettings && typeof packageSettings === 'object') value.packageSettings = packageSettings;
  localStorage.setItem(PREVIEW_KEY, JSON.stringify(value));
}
export function clearPreview() { localStorage.removeItem(PREVIEW_KEY); }
export function readPreview(raw = localStorage.getItem(PREVIEW_KEY), now = Date.now()) {
  try {
    const value = JSON.parse(raw);
    if (typeof value?.slot !== 'string' || !(now - value.at < PREVIEW_TTL)) return null;
    const out = {slot: value.slot, colors: placementOverride(value.colors) || null};
    if (value.packageSettings && typeof value.packageSettings === 'object' && !Array.isArray(value.packageSettings)) out.packageSettings = value.packageSettings;
    return out;
  } catch { return null; }
}

// Apply a placement's override to its tile. Built-in tiles read these variables, so
// setting them on the tile scopes the colours to it; without an override the tile
// inherits the dashboard's General colours.
export function applyTileColors(box, slot) {
  const primary = clean(slot?.colors?.primary), accent = clean(slot?.colors?.accent);
  for (const [name, value] of [['--primary', primary], ['--highlight', accent]]) {
    if (value) box.style.setProperty(name, value);
    else box.style.removeProperty(name);
  }
  box.toggleAttribute('data-colors', !!(primary || accent));
}
