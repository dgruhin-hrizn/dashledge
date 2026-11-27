// Pure helpers for the Reminders view: which reminders a placement shows, in what
// order and groups, and how due dates read. No DOM, so tests can load it in Node.
(root => {
  const pad = n => String(n).padStart(2, '0');
  const dayKey = date => date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  const addDays = (date, n) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);

  // The lists this placement shows: every list for ["*"], else the chosen ones that
  // still exist.
  function chosenLists(lists, wanted) {
    if (!Array.isArray(wanted) || wanted.includes('*')) return lists;
    const ids = new Set(wanted);
    return lists.filter(list => ids.has(list.id));
  }

  // Where a new reminder goes: the one chosen list, else the per-group list asked for,
  // else Reminders' default list ('').
  function addTarget(lists, wanted, preferred = '') {
    const writable = id => lists.some(list => list.id === id && list.writable !== false);
    if (preferred && writable(preferred)) return preferred;
    const chosen = Array.isArray(wanted) && !wanted.includes('*') ? wanted.filter(writable) : [];
    return chosen.length === 1 ? chosen[0] : '';
  }

  // Overdue and due ones by date and time, then undated; ties by priority (1 high … 9
  // low, 0 none last), then title. Finished ones after, most recent first. A reminder
  // just checked here sorts by `sortDone`, its state before the tap, so it stays put.
  function compare(a, b) {
    const doneA = a.sortDone ?? a.completed, doneB = b.sortDone ?? b.completed;
    if (doneA !== doneB) return doneA ? 1 : -1;
    if (doneA) return String(b.completedAt || '').localeCompare(String(a.completedAt || ''));
    if (!!a.due !== !!b.due) return a.due ? -1 : 1;
    const when = (a.due || '').localeCompare(b.due || '') || (a.dueTime || '99').localeCompare(b.dueTime || '99');
    if (when) return when;
    const rank = p => (p > 0 ? p : 10);
    return rank(a.priority) - rank(b.priority) || a.title.localeCompare(b.title, undefined, {sensitivity: 'base'});
  }

  // When a reminder is due, relative to `now`: {text, tone} with tone overdue, today or ''.
  function dueLabel(item, now = new Date()) {
    if (!item.due) return null;
    const [y, m, d] = item.due.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const today = dayKey(now), key = item.due;
    let time = '';
    if (item.dueTime) {
      const [h, min] = item.dueTime.split(':').map(Number);
      date.setHours(h, min);
      time = date.toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'});
    }
    const late = item.dueTime ? date < now : key < today;
    let day;
    if (key === today) day = 'Today';
    else if (key === dayKey(addDays(now, 1))) day = 'Tomorrow';
    else if (key === dayKey(addDays(now, -1))) day = 'Yesterday';
    else if (date > now && date < addDays(now, 7)) day = date.toLocaleDateString(undefined, {weekday: 'long'});
    else day = date.toLocaleDateString(undefined, {month: 'short', day: 'numeric', ...(y !== now.getFullYear() ? {year: 'numeric'} : {})});
    return {text: time ? day + ', ' + time : day, tone: !item.completed && late ? 'overdue' : key === today ? 'today' : ''};
  }

  // The due-date sections of the "By due date" arrangement.
  function dueSection(item, now = new Date()) {
    if (item.sortDone ?? item.completed) return 'done';
    if (!item.due) return 'later';
    const today = dayKey(now);
    if (item.due < today || (item.due === today && item.dueTime && dueLabel(item, now).tone === 'overdue')) return 'overdue';
    if (item.due === today) return 'today';
    if (item.due < dayKey(addDays(now, 7))) return 'week';
    return 'later';
  }
  const DUE_TITLES = {overdue: 'Overdue', today: 'Today', week: 'Next 7 days', later: 'Later', done: 'Finished today'};

  // Sections to draw: [{id, title, color, list, items}]. `list` is set when a group
  // stands for one Reminders list, so its + adds there.
  function sections(snapshot, settings = {}, now = new Date()) {
    const lists = chosenLists(snapshot.lists || [], settings.lists);
    const shown = new Set(lists.map(list => list.id));
    const items = (snapshot.items || [])
      .filter(item => shown.has(item.listId) && (settings.finished !== false || !(item.sortDone ?? item.completed)))
      .sort(compare);
    if (settings.group === 'due') {
      const byId = new Map();
      for (const item of items) {
        const id = dueSection(item, now);
        if (!byId.has(id)) byId.set(id, {id, title: DUE_TITLES[id], color: '', list: '', items: []});
        byId.get(id).items.push(item);
      }
      return Object.keys(DUE_TITLES).filter(id => byId.has(id)).map(id => byId.get(id));
    }
    return lists.map(list => ({id: list.id, title: list.title, color: list.color || '', list: list.writable === false ? '' : list.id,
      items: items.filter(item => item.listId === list.id)}));
  }

  // Counts for the summary: open, due today and overdue among the shown lists.
  function counts(snapshot, settings = {}, now = new Date()) {
    const shown = new Set(chosenLists(snapshot.lists || [], settings.lists).map(list => list.id));
    const open = (snapshot.items || []).filter(item => !item.completed && shown.has(item.listId));
    const kinds = open.map(item => dueSection({...item, sortDone: undefined}, now));
    return {open: open.length, today: kinds.filter(k => k === 'today').length, overdue: kinds.filter(k => k === 'overdue').length};
  }

  // Today's progress for the hero dial: finished today against what was due by tonight.
  function progress(snapshot, settings = {}, now = new Date()) {
    const shown = new Set(chosenLists(snapshot.lists || [], settings.lists).map(list => list.id));
    const items = (snapshot.items || []).filter(item => shown.has(item.listId));
    const done = items.filter(item => item.completed).length;
    const due = items.filter(item => !item.completed && ['overdue', 'today'].includes(dueSection({...item, sortDone: undefined}, now))).length;
    return {done, due, total: done + due, ratio: done + due ? done / (done + due) : 0};
  }

  // The open reminder to do next: the earliest due, else the highest priority.
  function nextUp(snapshot, settings = {}, now = new Date()) {
    const shown = new Set(chosenLists(snapshot.lists || [], settings.lists).map(list => list.id));
    return (snapshot.items || []).filter(item => !item.completed && shown.has(item.listId) && (item.due || item.priority > 0))
      .sort(compare)[0] || null;
  }

  // "in 45 min", "in 3 h", "2 d overdue"… for the next-up line; null without a due date.
  function relative(item, now = new Date()) {
    if (!item?.due) return null;
    const [y, m, d] = item.due.split('-').map(Number);
    const [h, min] = (item.dueTime || '23:59').split(':').map(Number);
    const minutes = Math.round((new Date(y, m - 1, d, h, min) - now) / 60000);
    const span = Math.abs(minutes);
    const text = span < 60 ? span + ' min' : span < 24 * 60 ? Math.round(span / 60) + ' h' : Math.round(span / 1440) + ' d';
    if (!item.dueTime && item.due === dayKey(now)) return {text: 'today', late: false};
    return minutes < 0 ? {text: text + ' overdue', late: true} : {text: 'in ' + text, late: false};
  }

  // Text to set on a filled colour: near-black or white, whichever contrasts more
  // (WCAG relative luminance). Highlight and list colours are #rgb or #rrggbb.
  const DARK = '#120c08', LIGHT = '#ffffff';
  const rgb = hex => {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    const h = m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1];
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  };
  const luminance = ([r, g, b]) => {
    const lin = v => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  function onColor(hex) {
    const c = rgb(hex);
    if (!c) return DARK;
    const l = luminance(c);
    // Contrast with near-black (luminance ≈ 0.004) against contrast with white.
    return (l + 0.05) / 0.054 >= 1.05 / (l + 0.05) ? DARK : LIGHT;
  }

  // A colour used as text on the dark cards: itself when it reads at 4.5:1 against
  // the card, else mixed toward white just until it does. Keeps the hue recognisable.
  const CARD = luminance([0x13, 0x19, 0x24]);
  function readable(hex) {
    const c = rgb(hex);
    if (!c) return '';
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const mixed = c.map(v => Math.round(v + (255 - v) * t));
      if ((luminance(mixed) + 0.05) / (CARD + 0.05) >= 4.5)
        return '#' + mixed.map(v => v.toString(16).padStart(2, '0')).join('');
    }
    return LIGHT;
  }

  // Options for the placement's Lists setting.
  function listOptions(lists) {
    return lists.slice(0, 64).map(list => ({value: list.id.slice(0, 128), label: String(list.title).slice(0, 64),
      ...(list.account ? {detail: String(list.account).slice(0, 120)} : {})}))
      .filter(option => /^[A-Za-z0-9._:@/-]{1,128}$/.test(option.value));
  }

  const api = {chosenLists, addTarget, compare, dueLabel, dueSection, sections, counts, progress, nextUp, relative, onColor, readable, listOptions};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RemindersModel = api;
})(typeof globalThis === 'object' ? globalThis : this);
