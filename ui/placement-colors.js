// Per-placement colours. General settings choose the text and highlight colours every
// widget follows; a placement may override either for itself, saved on its slot as
// `colors: {primary?, accent?}`. A missing value keeps following General.
import {el, button} from './common.js';

const HEX = /^#[0-9a-f]{6}$/i;
const clean = value => typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : null;

// Built-in widgets with a palette of their own (artwork, brand or provider colours).
const ownPalette = new Set(['applemusic', 'spotify', 'plans', 'markets', 'photos', 'shortcuts', 'rundmd', 'empty']);

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

// Live preview while the colours editor is open. The settings window writes the
// draft here; the dashboard shows it on that one placement without saving it, and
// drops it when the key goes away. A stale preview (editor closed abnormally) expires.
export const PREVIEW_KEY = 'edge.colorPreview';
const PREVIEW_TTL = 10 * 60 * 1000;
export function writePreview(slot, colors) {
  localStorage.setItem(PREVIEW_KEY, JSON.stringify({slot, colors: placementOverride(colors) || {}, at: Date.now()}));
}
export function clearPreview() { localStorage.removeItem(PREVIEW_KEY); }
export function readPreview(raw = localStorage.getItem(PREVIEW_KEY), now = Date.now()) {
  try {
    const value = JSON.parse(raw);
    if (typeof value?.slot !== 'string' || !(now - value.at < PREVIEW_TTL)) return null;
    return {slot: value.slot, colors: placementOverride(value.colors) || null};
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

// The editor: one swatch per colour, each with "Use General", and a live sample.
// `save(override)` receives null when both follow General again. Resolves with the
// saved override (or null), or undefined when cancelled.
export function editPlacementColors({title, value, general, save, preview = () => {}}) {
  return new Promise(resolve => {
    const draft = {primary: clean(value?.primary), accent: clean(value?.accent)};
    let result;
    const dialog = el('dialog', 'admin-dialog placement-colors');
    dialog.setAttribute('aria-label', title);
    const sample = el('div', 'color-sample'), reading = el('strong', '', '72'), unit = el('span', '', '%'), caption = el('small', '', 'CPU load');
    reading.append(unit);
    sample.append(caption, reading, el('i'));
    const rows = el('div', 'color-rows'), status = el('p', 'form-error');
    status.setAttribute('role', 'alert');

    function paint() {
      const colors = placementColors({colors: draft}, general);
      sample.style.setProperty('--sample-text', colors.primary);
      sample.style.setProperty('--sample-accent', colors.accent);
      preview({primary: draft.primary, accent: draft.accent});
    }
    const pickers = {};
    for (const [key, label] of [['primary', 'Text'], ['accent', 'Highlight']]) {
      const picker = el('input'), follow = el('input'), hex = el('code');
      picker.type = 'color';
      picker.setAttribute('aria-label', label + ' colour');
      follow.type = 'checkbox';
      const sync = () => {
        const current = draft[key] || general[key];
        picker.value = current;
        picker.disabled = !draft[key];
        follow.checked = !draft[key];
        hex.textContent = draft[key] ? current : current + ' · General';
        paint();
      };
      pickers[key] = picker;
      // The Mac's colour panel may report a choice with input or only with change.
      picker.oninput = picker.onchange = () => { draft[key] = clean(picker.value); sync(); };
      follow.onchange = () => { draft[key] = follow.checked ? null : clean(picker.value) || general[key]; sync(); };
      const followLabel = el('label', 'color-follow');
      followLabel.append(follow, el('span', '', 'Use General'));
      const row = el('div', 'color-row');
      row.append(el('span', 'color-name', label), picker, hex, followLabel);
      rows.append(row);
      sync();
    }

    const footer = el('div', 'row form-actions');
    footer.append(button('Cancel', () => dialog.close()), button('Save', () => {
      // Read the pickers themselves, in case the colour panel hasn't reported yet.
      for (const key of ['primary', 'accent']) if (draft[key] && clean(pickers[key].value)) draft[key] = clean(pickers[key].value);
      const override = placementOverride(draft, general);
      try {
        save(override);
        result = override;
        dialog.close();
      } catch (error) {
        status.textContent = String(error?.message || error);
      }
    }, 'primary'));
    const intro = el('p', 'sub', 'Colours for this placement only. Other placements and widgets keep the General colours.');
    dialog.append(el('h2', '', title), intro, sample, rows, status, footer);
    dialog.onclose = () => { preview(undefined); dialog.remove(); resolve(result); };
    document.body.append(dialog);
    dialog.showModal();
  });
}
