// Reminders: what's due across the chosen lists, tap the ring to check one off, + adds
// one with the touch keyboard. Data comes from EventKit through the `reminders`
// capability; nothing is collected in the background.
(() => {
  const host = window.Dashledge;
  const M = window.RemindersModel;
  const $ = id => document.getElementById(id);
  const widget = $('widget'), body = $('body'), count = $('count'), subline = $('subline'), addButton = $('add'), toast = $('toast');
  const REFRESH = 15000, HOLD = 4000;

  let snapshot = null, failure = '', settings = {lists: ['*'], finished: true, group: 'lists'};
  let reading = false, offered = '', toastTimer = 0;
  // Reminders checked or unchecked here in the last few seconds stay where they were,
  // so the row under a finger doesn't jump away. id → {completed, until}.
  const held = new Map();

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function say(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 4000);
  }

  // The snapshot as drawn: held changes applied over what EventKit last said.
  function current() {
    if (!snapshot) return null;
    const now = Date.now();
    for (const [id, hold] of held) if (hold.until < now) held.delete(id);
    const items = (snapshot.items || []).map(item => held.has(item.id)
      ? {...item, completed: held.get(item.id).completed, sortDone: held.get(item.id).sortDone} : item);
    return {...snapshot, items};
  }

  async function read(request = false) {
    if (reading && !request) return;
    reading = true;
    try {
      snapshot = await host.reminders.read({request});
      failure = snapshot.permission === 'allowed' ? (snapshot.error || '') : '';
    } catch (error) {
      failure = String(error?.message || error);
    } finally {
      reading = false;
    }
    draw();
    offer();
  }

  // Tell Dashledge which lists exist, for this placement's Lists setting.
  function offer() {
    if (snapshot?.permission !== 'allowed' || !snapshot.lists) return;
    const options = M.listOptions(snapshot.lists);
    const key = JSON.stringify(options);
    if (key === offered) return;
    offered = key;
    host.settings.offer('lists', options).catch(() => { offered = ''; });
  }

  function message(title, detail, actions = []) {
    const box = el('div', 'rm-message');
    box.append(el('strong', '', title));
    if (detail) box.append(el('span', '', detail));
    if (actions.length) {
      const row = el('div', 'rm-message-actions');
      for (const [label, run, primary] of actions) {
        const button = el('button', 'rm-button' + (primary ? ' rm-primary' : ''), label);
        button.type = 'button';
        button.onclick = run;
        row.append(button);
      }
      box.append(row);
    }
    return box;
  }

  function row(item, color) {
    const li = el('li', 'rm-row');
    li.dataset.id = item.id;
    li.dataset.done = String(!!item.completed);
    if (color) li.style.setProperty('--list', color);
    const check = el('button', 'rm-check');
    check.type = 'button';
    check.setAttribute('aria-pressed', String(!!item.completed));
    check.setAttribute('aria-label', (item.completed ? 'Mark not done: ' : 'Mark done: ') + item.title);
    check.onclick = () => toggle(item);
    const text = el('div', 'rm-text');
    const title = el('span', 'rm-title', item.title || 'New Reminder');
    if (item.priority > 0) title.prepend(el('b', 'rm-priority', item.priority <= 4 ? '!!! ' : item.priority === 5 ? '!! ' : '! '));
    text.append(title);
    const due = M.dueLabel(item);
    const meta = [];
    if (due) {
      const when = el('span', 'rm-due', due.text);
      if (due.tone) when.dataset.tone = due.tone;
      meta.push(when);
    }
    if (item.notes) meta.push(el('span', 'rm-notes', item.notes));
    if (meta.length) {
      const line = el('span', 'rm-meta');
      line.append(...meta);
      text.append(line);
    }
    li.append(check, text);
    return li;
  }

  function section(group, many) {
    const box = el('section', 'rm-group');
    box.dataset.id = group.id;
    if (group.color) box.style.setProperty('--list', group.color);
    if (many) {
      const head = el('header', 'rm-group-head');
      head.append(el('h2', '', group.title), el('span', 'rm-group-count', String(group.items.filter(i => !i.completed).length)));
      if (group.list) {
        const plus = el('button', 'rm-icon rm-small');
        plus.type = 'button';
        plus.setAttribute('aria-label', 'New reminder in ' + group.title);
        plus.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
        plus.onclick = () => add(group.list, group.title);
        head.append(plus);
      }
      box.append(head);
    }
    const list = el('ul', 'rm-list');
    for (const item of group.items) list.append(row(item, group.color || colorOf(item.listId)));
    if (!group.items.length) list.append(el('li', 'rm-none', 'Nothing here'));
    box.append(list);
    return box;
  }
  const colorOf = id => snapshot?.lists?.find(list => list.id === id)?.color || '';

  function draw() {
    // Keep each group's scroll position and the page's across redraws.
    const scrolls = new Map([...body.querySelectorAll('.rm-group')].map(g => [g.dataset.id, g.querySelector('.rm-list')?.scrollTop || 0]));
    const outer = body.scrollTop, across = body.scrollLeft;
    const data = current();
    addButton.hidden = true;
    if (!data) {
      widget.dataset.state = failure ? 'error' : 'loading';
      count.textContent = '–';
      subline.textContent = 'Reminders';
      body.replaceChildren(failure
        ? message('Couldn’t read Reminders', failure, [['Try again', () => read()]])
        : message('Reading Reminders…'));
      return;
    }
    if (data.permission === 'request') {
      widget.dataset.state = 'permission';
      count.textContent = '';
      subline.textContent = 'Reminders';
      body.replaceChildren(message('Show your reminders here', data.detail || 'macOS asks once whether Dashledge may use Reminders.',
        [['Show my Reminders', () => read(true), true]]));
      return;
    }
    if (data.permission === 'denied') {
      widget.dataset.state = 'permission';
      count.textContent = '';
      subline.textContent = 'Reminders';
      body.replaceChildren(message('Reminders is off for Dashledge', data.detail || 'Turn on Dashledge in Privacy & Security › Reminders, then come back.',
        [['Open Privacy settings', () => host.reminders.openPrivacy().catch(e => say(String(e.message || e))), true], ['Check again', () => read()]]));
      return;
    }
    widget.dataset.state = 'ready';
    addButton.hidden = false;
    const tally = M.counts(data, settings);
    count.textContent = String(tally.open);
    subline.textContent = tally.overdue ? tally.overdue + ' overdue' + (tally.today ? ' · ' + tally.today + ' today' : '')
      : tally.today ? tally.today + ' due today' : tally.open === 1 ? 'reminder' : 'reminders';
    subline.dataset.tone = tally.overdue ? 'overdue' : '';
    const groups = M.sections(data, settings).filter(group => group.items.length || settings.group !== 'due');
    const visible = settings.group === 'due' ? groups : groups.filter(group => group.items.length || M.chosenLists(data.lists || [], settings.lists).length <= 6);
    const nodes = [];
    if (failure) nodes.push(el('p', 'rm-stale', failure));
    if (!(data.lists || []).length) nodes.push(message('No Reminders lists yet', 'Create a list in Reminders on this Mac.'));
    else if (!M.chosenLists(data.lists, settings.lists).length)
      nodes.push(message('Your chosen lists are gone', 'Choose lists for this placement.', [['Choose lists', openSettings, true]]));
    else if (!tally.open && !visible.some(group => group.items.length))
      nodes.push(message('All done', 'Nothing left in these lists.', [['New reminder', () => add(), true]]));
    else {
      const many = visible.length > 1;
      widget.dataset.groups = String(visible.length);
      for (const group of visible) nodes.push(section(group, many));
    }
    body.replaceChildren(...nodes);
    for (const g of body.querySelectorAll('.rm-group')) {
      const list = g.querySelector('.rm-list');
      if (list && scrolls.has(g.dataset.id)) list.scrollTop = scrolls.get(g.dataset.id);
    }
    body.scrollTop = outer;
    body.scrollLeft = across;
  }

  async function toggle(item) {
    const before = held.get(item.id);
    const completed = !(before?.completed ?? item.completed);
    // Keep the row where it was when first tapped until the hold runs out.
    held.set(item.id, {completed, sortDone: before?.sortDone ?? !!item.completed, until: Date.now() + HOLD});
    draw();
    try {
      const result = await host.reminders.setCompleted(item.id, completed);
      const fresh = result?.item;
      if (fresh && snapshot?.items) snapshot.items = snapshot.items.map(i => i.id === fresh.id ? fresh : i);
      setTimeout(() => { if ((held.get(item.id)?.until || 0) <= Date.now()) read(); }, HOLD + 50);
    } catch (error) {
      held.delete(item.id);
      draw();
      say('Couldn’t change “' + item.title + '”: ' + String(error?.message || error).replace(/^Error: /, ''));
    }
  }

  async function add(preferred = '', where = '') {
    const list = M.addTarget(snapshot?.lists || [], settings.lists, preferred);
    const name = where || (list ? snapshot.lists.find(l => l.id === list)?.title : '') || '';
    let title;
    try {
      title = await host.keyboard.open({title: name ? 'New reminder in ' + name : 'New reminder', placeholder: 'Reminder', actionLabel: 'Add', maxLength: 300});
    } catch (error) {
      say(String(error?.message || error).replace(/^Error: /, ''));
      return;
    }
    if (!title || !title.trim()) return;
    try {
      const result = await host.reminders.add(title.trim(), {list});
      if (result?.item && snapshot?.items) snapshot.items = [...snapshot.items, result.item];
      draw();
      read();
    } catch (error) {
      say('Couldn’t add “' + title.trim() + '”: ' + String(error?.message || error).replace(/^Error: /, ''));
    }
  }

  function openSettings() {
    host.settings.open().catch(error => say(String(error?.message || error).replace(/^Error: /, '')));
  }

  addButton.onclick = () => add();
  $('gear').onclick = openSettings;

  host.subscribe(state => {
    const s = state.settings || {};
    settings = {lists: Array.isArray(s.lists) ? s.lists : ['*'], finished: s.finished !== false, group: s.group === 'due' ? 'due' : 'lists'};
    widget.dataset.arrange = settings.group;
    draw();
  });
  host.settings.onRefresh(() => { offered = ''; read(); });
  read();
  setInterval(read, REFRESH);
  // Relative due labels ("Today, 3:00 PM", overdue) move with the clock.
  setInterval(draw, 60000);
})();
