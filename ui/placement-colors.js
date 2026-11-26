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
export function editPlacementColors({title, value, general, save}) {
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
    }
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
      picker.oninput = () => { draft[key] = clean(picker.value); sync(); };
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
    dialog.onclose = () => { dialog.remove(); resolve(result); };
    document.body.append(dialog);
    dialog.showModal();
  });
}
