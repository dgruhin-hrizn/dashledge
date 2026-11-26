// Per-placement settings for API version 2 packages that declare the `settings`
// permission. Rust validates each manifest's setting schema; this module resolves a
// placement's values against it and draws the one editor that Pages & layouts and the
// package's own gear on the dashboard both open.
import {el, button, field} from './common.js';
import {openTouchKeyboard} from './search-keyboard.js';
import {CHOICE_VALUE, MAX_CHOICES, readChoices, requestRefresh, watchChoices} from './package-choices.js';

const clean = (value, limit) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit);
const textLimit = setting => setting.maxLength ?? (setting.type === 'names' ? 48 : 256);
const listed = (setting, value) => !!setting.options?.some(option => option.value === value);
// `["*"]` in a multi setting means every option, including ones offered later.
export const EVERY = '*';
const isEvery = value => Array.isArray(value) && value.length === 1 && value[0] === EVERY;
const copy = value => Array.isArray(value) ? [...value] : value && typeof value === 'object' ? {...value} : value;

function fallback(setting) {
  if (setting.default !== undefined) return copy(setting.default);
  if (setting.type === 'number') return setting.min ?? 0;
  if (setting.type === 'toggle') return false;
  if (setting.type === 'choice') return setting.dynamic ? '' : setting.options?.[0]?.value ?? '';
  if (setting.type === 'multi') return [EVERY];
  if (setting.type === 'names') return {};
  return '';
}

// Dynamic values are checked by shape only, never against the options a view offered:
// an account that is offline right now must keep its place and its name.
function fits(setting, value) {
  switch (setting.type) {
    case 'text': return typeof value === 'string' && value.length <= textLimit(setting);
    case 'number': return typeof value === 'number' && Number.isFinite(value) &&
      (setting.min == null || value >= setting.min) && (setting.max == null || value <= setting.max);
    case 'toggle': return typeof value === 'boolean';
    case 'choice': return setting.dynamic ? typeof value === 'string' && (value === '' || CHOICE_VALUE.test(value)) : listed(setting, value);
    case 'multi': return Array.isArray(value) && value.length <= MAX_CHOICES && (isEvery(value) ||
      (new Set(value).size === value.length && value.every(v => typeof v === 'string' &&
        (setting.dynamic ? CHOICE_VALUE.test(v) : listed(setting, v)))));
    case 'names': return !!value && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).length <= MAX_CHOICES && Object.entries(value).every(([key, name]) =>
        CHOICE_VALUE.test(key) && typeof name === 'string' && name.length <= textLimit(setting));
    default: return false;
  }
}

function resolved(setting, value) {
  if (setting.type === 'text') return clean(value, textLimit(setting));
  if (setting.type === 'names') {
    const names = {};
    for (const [key, name] of Object.entries(value)) if (clean(name, textLimit(setting)).trim()) names[key] = clean(name, textLimit(setting)).trim();
    return names;
  }
  return copy(value);
}

// A placement's values: saved values that still fit the schema, the manifest's
// defaults for the rest, and nothing the schema doesn't name.
export function settingValues(schema = [], saved = {}) {
  const values = {};
  for (const setting of schema || []) {
    const value = saved?.[setting.id];
    values[setting.id] = fits(setting, value) ? resolved(setting, value) : fallback(setting);
  }
  return values;
}

// The settings controls for one placement, drawn into `form`. Every change updates
// `draft` and calls `onChange(draft)`. The dialog below and the inline placement panel
// in Pages & layouts both use it, so a package's settings look the same everywhere.
// `choices` ({kind, source}) names the placement whose offered options dynamic settings list.
export function settingsForm({schema = [], draft, touch = false, brand = '', icon = '', choices = null, onChange = () => {}}) {
  const form = el('div', 'package-settings-form');
  const changed = () => onChange(draft);
  // Lists of offered options redraw when a view offers new ones, in any window.
  const redraws = [];
  let offered = choices ? readChoices(choices.kind, choices.source) : {};
  for (const setting of schema) {
    const control = editor(setting);
    const wrap = setting.type === 'multi' || setting.type === 'names' ? group(setting.label, control) : field(setting.label, control);
    if (setting.help) wrap.append(el('small', 'sub', setting.help));
    form.append(wrap);
  }
  if (choices && redraws.length) {
    let shown = false;
    const stop = watchChoices(() => {
      if (form.isConnected) shown = true;
      else if (shown) return stop();
      offered = readChoices(choices.kind, choices.source);
      for (const redraw of redraws) redraw();
    });
  }
  return form;

  function group(label, control) {
    const wrap = el('fieldset', 'package-settings-group');
    wrap.append(el('legend', '', label), control);
    return wrap;
  }
  // What a list setting offers: its own options or the view's, plus saved values that
  // aren't offered right now, so they can still be seen and removed.
  function optionsOf(setting, keep = []) {
    const list = setting.dynamic ? offered[setting.id] || [] : setting.options || [];
    const out = list.map(option => ({...option}));
    for (const value of keep) if (value && value !== EVERY && !out.some(option => option.value === value))
      out.push({value, label: value, detail: 'Not available right now', missing: true});
    return out;
  }
  function checkNow() {
    const status = el('span', 'sub package-settings-status');
    status.setAttribute('role', 'status');
    const control = button('Check now', () => {
      requestRefresh(choices.kind, choices.source);
      status.textContent = 'Checking. Results appear as each one answers.';
    });
    const line = el('div', 'package-settings-check');
    line.append(control, status);
    return line;
  }
  function optionText(option) {
    const text = el('span', 'package-settings-option');
    text.append(el('span', '', option.label));
    if (option.detail) {
      const detail = el('small', 'sub', option.detail);
      if (option.missing) detail.dataset.missing = 'true';
      text.append(detail);
    }
    return text;
  }
  function multiEditor(setting) {
    const id = setting.id, wrap = el('div', 'package-settings-multi'), list = el('div', 'package-settings-list');
    const every = el('input');
    every.type = 'checkbox';
    const everyLabel = el('label', 'package-settings-row');
    everyLabel.append(every, el('span', '', setting.dynamic ? 'All, including ones found later' : 'All'));
    every.onchange = () => {
      draft[id] = every.checked ? [EVERY] : optionsOf(setting).map(option => option.value);
      draw();
      changed();
    };
    const draw = () => {
      const all = isEvery(draft[id]);
      every.checked = all;
      list.replaceChildren();
      const options = optionsOf(setting, draft[id]);
      if (!options.length) list.append(el('p', 'sub', setting.dynamic ? 'Nothing found yet.' : 'No options.'));
      for (const option of options) {
        const box = el('input'), row = el('label', 'package-settings-row');
        box.type = 'checkbox';
        box.checked = all || draft[id].includes(option.value);
        box.disabled = all;
        box.onchange = () => {
          const rest = draft[id].filter(value => value !== option.value);
          draft[id] = box.checked ? [...rest, option.value] : rest;
          changed();
        };
        row.append(box, optionText(option));
        list.append(row);
      }
    };
    redraws.push(draw);
    draw();
    wrap.append(everyLabel, list);
    if (setting.dynamic && choices) wrap.append(checkNow());
    return wrap;
  }
  // A name for each option of the setting named by `for`.
  function namesEditor(setting) {
    const id = setting.id, target = schema.find(item => item.id === setting.for), list = el('div', 'package-settings-list');
    const draw = () => {
      // Don't take a field away while it's being typed in.
      if (list.contains(document.activeElement)) return;
      list.replaceChildren();
      const chosen = target ? draft[target.id] : [];
      const keep = [...(Array.isArray(chosen) ? chosen : [chosen]), ...Object.keys(draft[id])];
      const options = target ? optionsOf(target, keep) : [];
      if (!options.length) list.append(el('p', 'sub', 'Nothing to name yet.'));
      for (const option of options) {
        const input = el('input');
        input.type = 'text';
        input.maxLength = textLimit(setting);
        input.placeholder = option.label;
        input.value = draft[id][option.value] || '';
        input.setAttribute('aria-label', 'Name for ' + option.label);
        const apply = text => {
          const names = {...draft[id]}, value = clean(text, textLimit(setting)).trim();
          if (value) names[option.value] = value; else delete names[option.value];
          draft[id] = names;
          changed();
        };
        input.oninput = () => apply(input.value);
        if (touch) keyboardFor(input, option.label, setting, apply);
        const row = el('label', 'package-settings-row');
        row.append(optionText({label: option.label, detail: option.missing ? option.detail : '', missing: option.missing}), input);
        list.append(row);
      }
    };
    redraws.push(draw);
    draw();
    return list;
  }
  // On the Edge, text comes from the shared touch keyboard.
  function keyboardFor(input, title, setting, apply) {
    input.readOnly = true;
    input.inputMode = 'none';
    input.onclick = () => {
      const sheet = openTouchKeyboard({title, brand, icon, placeholder: title,
        actionLabel: 'Done', maxLength: textLimit(setting), onSubmit: () => {
          input.value = clean(sheet.input.value, textLimit(setting));
          apply(input.value);
          sheet.dialog.close();
        }});
      sheet.input.value = input.value;
    };
  }

  function editor(setting) {
    const id = setting.id;
    if (setting.type === 'multi') return multiEditor(setting);
    if (setting.type === 'names') return namesEditor(setting);
    if (setting.type === 'choice' && setting.dynamic) {
      const choice = el('select');
      const draw = () => {
        choice.replaceChildren(new Option('Automatic', ''));
        for (const option of optionsOf(setting, [draft[id]])) choice.add(new Option(option.missing ? option.label + ' (not available right now)' : option.label, option.value));
        choice.value = draft[id];
      };
      choice.onchange = () => { draft[id] = choice.value; changed(); };
      redraws.push(draw);
      draw();
      return choice;
    }
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
export function editPackageSettings({title, brand = title, icon = '', schema = [], values = {}, touch = false, choices = null, save}) {
  return new Promise(resolve => {
    const draft = settingValues(schema, values);
    let result = null;
    const dialog = el('dialog', 'package-settings');
    dialog.setAttribute('aria-label', title);
    const form = settingsForm({schema, draft, touch, brand, icon, choices}), status = el('p', 'package-settings-error');
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
