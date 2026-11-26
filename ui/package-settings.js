// Per-placement settings for API version 2 packages that declare the `settings`
// permission. Rust validates each manifest's setting schema; this module resolves a
// placement's values against it and draws the one editor that Pages & layouts and the
// package's own gear on the dashboard both open.
import {el, button, field} from './common.js';
import {openTouchKeyboard} from './search-keyboard.js';

const clean = (value, limit) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit);
const textLimit = setting => setting.maxLength ?? 256;

function fallback(setting) {
  if (setting.default !== undefined) return setting.default;
  if (setting.type === 'number') return setting.min ?? 0;
  if (setting.type === 'toggle') return false;
  if (setting.type === 'choice') return setting.options?.[0]?.value ?? '';
  return '';
}

function fits(setting, value) {
  switch (setting.type) {
    case 'text': return typeof value === 'string' && value.length <= textLimit(setting);
    case 'number': return typeof value === 'number' && Number.isFinite(value) &&
      (setting.min == null || value >= setting.min) && (setting.max == null || value <= setting.max);
    case 'toggle': return typeof value === 'boolean';
    case 'choice': return !!setting.options?.some(option => option.value === value);
    default: return false;
  }
}

// A placement's values: saved values that still fit the schema, the manifest's
// defaults for the rest, and nothing the schema doesn't name.
export function settingValues(schema = [], saved = {}) {
  const values = {};
  for (const setting of schema || []) {
    const value = saved?.[setting.id];
    values[setting.id] = fits(setting, value) ? (setting.type === 'text' ? clean(value, textLimit(setting)) : value) : fallback(setting);
  }
  return values;
}

// The settings controls for one placement, drawn into `form`. Every change updates
// `draft` and calls `onChange(draft)`. The dialog below and the inline placement panel
// in Pages & layouts both use it, so a package's settings look the same everywhere.
export function settingsForm({schema = [], draft, touch = false, brand = '', icon = '', onChange = () => {}}) {
  const form = el('div', 'package-settings-form');
  const changed = () => onChange(draft);
  for (const setting of schema) {
    const control = editor(setting);
    const wrap = field(setting.label, control);
    if (setting.help) wrap.append(el('small', 'sub', setting.help));
    form.append(wrap);
  }
  return form;

  function editor(setting) {
    const id = setting.id;
    if (setting.type === 'toggle') {
      const box = el('input');
      box.type = 'checkbox';
      box.checked = draft[id] === true;
      box.onchange = () => { draft[id] = box.checked; changed(); };
      return box;
    }
    if (setting.type === 'choice') {
      const options = setting.options || [];
      if (options.length > 4) {
        const choice = el('select');
        for (const option of options) choice.add(new Option(option.label, option.value));
        choice.value = draft[id];
        choice.onchange = () => { draft[id] = choice.value; changed(); };
        return choice;
      }
      const group = el('div', 'package-settings-choices');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', setting.label);
      const draw = () => {
        for (const [index, node] of [...group.children].entries())
          node.setAttribute('aria-pressed', String(options[index].value === draft[id]));
      };
      for (const option of options) group.append(button(option.label, () => { draft[id] = option.value; draw(); changed(); }));
      draw();
      return group;
    }
    if (setting.type === 'number') {
      const step = setting.step || 1;
      const input = el('input');
      input.type = 'number';
      input.setAttribute('aria-label', setting.label);
      if (setting.min != null) input.min = setting.min;
      if (setting.max != null) input.max = setting.max;
      input.step = step;
      input.value = draft[id];
      if (touch) { input.readOnly = true; input.inputMode = 'none'; }
      const set = value => {
        if (!Number.isFinite(value)) return;
        const bounded = Math.min(setting.max ?? Infinity, Math.max(setting.min ?? -Infinity, value));
        draft[id] = Number(bounded.toFixed(6));
        input.value = draft[id];
        changed();
      };
      input.onchange = () => set(Number(input.value));
      const down = button('−', () => set(Number(draft[id]) - step)), up = button('+', () => set(Number(draft[id]) + step));
      down.setAttribute('aria-label', 'Decrease ' + setting.label);
      up.setAttribute('aria-label', 'Increase ' + setting.label);
      const stepper = el('div', 'package-settings-stepper');
      stepper.append(down, input, up);
      return stepper;
    }
    const input = el('input');
    input.type = 'text';
    input.maxLength = textLimit(setting);
    input.value = draft[id];
    input.oninput = () => { draft[id] = clean(input.value, textLimit(setting)); changed(); };
    if (touch) {
      // On the Edge, text comes from the shared touch keyboard.
      input.readOnly = true;
      input.inputMode = 'none';
      input.onclick = () => {
        const sheet = openTouchKeyboard({title: setting.label, brand, icon, placeholder: setting.label,
          actionLabel: 'Done', maxLength: textLimit(setting), onSubmit: () => {
            draft[id] = clean(sheet.input.value, textLimit(setting));
            input.value = draft[id];
            changed();
            sheet.dialog.close();
          }});
        sheet.input.value = draft[id];
      };
    }
    return input;
  }
}

// Open the settings editor for one placement. The draft changes only on Save:
// `save(values)` stores them (and may throw to keep the editor open with a message).
// Resolves with the saved values, or null when cancelled.
export function editPackageSettings({title, brand = title, icon = '', schema = [], values = {}, touch = false, save}) {
  return new Promise(resolve => {
    const draft = settingValues(schema, values);
    let result = null;
    const dialog = el('dialog', 'package-settings');
    dialog.setAttribute('aria-label', title);
    const form = settingsForm({schema, draft, touch, brand, icon}), status = el('p', 'package-settings-error');
    status.setAttribute('role', 'alert');

    const footer = el('footer');
    footer.append(button('Cancel', () => dialog.close()), button('Save', () => {
      const values = settingValues(schema, draft);
      try {
        save(values);
        result = values;
        dialog.close();
      } catch (error) {
        status.textContent = String(error?.message || error);
      }
    }, 'primary'));
    dialog.append(el('h2', '', title), form, status, footer);
    dialog.onclose = () => { dialog.remove(); resolve(result); };
    document.body.append(dialog);
    dialog.showModal();
  });
}
