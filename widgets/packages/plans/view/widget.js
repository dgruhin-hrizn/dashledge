// AI Plan Monitor view. Read-only on every display: which accounts a placement shows
// and what they're called live in its settings (Pages & layouts on the Mac), and the
// collector reads every account on its own schedule.
(() => {
  const M = globalThis.planModel;
  const host = window.Dashledge;
  const box = document.querySelector('.pm-widget');
  const view = document.getElementById('accounts');

  // Shown before the first snapshot so a placement isn't empty while the collector starts.
  const fallbackAccounts = [
    {id: 'claude:main', provider: 'Claude', name: 'Default', windows: [], state: 'checking'},
    {id: 'codex:local', provider: 'Codex', name: 'Current account', windows: [], state: 'checking'},
  ];
  // A reading that stops arriving for this long means the collector stopped.
  const OFFLINE_AFTER = 20000;
  let snapshot, offline = false, lastRead = 0, loading = false;
  let prefs = {accounts: ['*'], names: {}};
  let drawn = '', offered = '';

  function el(tag, cls = '', text = '') {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  }
  function accounts() {
    if (!snapshot) return fallbackAccounts;
    const result = [...snapshot.accounts];
    for (const item of fallbackAccounts) if (!result.some(a => a.provider === item.provider)) result.push(item);
    return result;
  }
  const context = () => ({loaded: !!snapshot, offline});

  function identity(a, alias) {
    const line = el('span', 'pm-identity'), mark = el('span', 'pm-mark');
    line.dataset.provider = a.provider;
    const img = el('img');
    img.src = (a.provider === 'Claude' ? 'claude' : 'codex') + '-color.svg';
    img.alt = '';
    mark.append(img);
    mark.setAttribute('aria-hidden', 'true');
    const text = el('span', 'pm-idtext'), top = el('span', 'pm-idtop');
    top.append(el('strong', '', a.provider));
    if (a.plan) top.append(el('span', 'pm-plan', a.plan));
    text.append(top, el('span', 'pm-alias', alias || a.name));
    line.append(mark, text);
    return line;
  }
  function dial(w, now) {
    const face = el('div', 'pm-dial'), scale = el('i', 'pm-scale'), arc = el('i', 'pm-arc'), center = el('span', 'pm-dial-center');
    const s = w && M.windowState(w, now);
    arc.style.setProperty('--sweep', ((s?.left ?? 0) * 2.7) + 'deg');
    scale.setAttribute('aria-hidden', 'true');
    arc.setAttribute('aria-hidden', 'true');
    if (s) {
      const value = el('span', 'pm-value');
      value.append(el('b', '', String(s.left)), el('small', '', '%'));
      center.append(value, el('span', 'pm-dial-label', 'left'));
      face.setAttribute('role', 'img');
      face.setAttribute('aria-label', s.left + '% left · ' + w.label);
    } else {
      center.append(el('b', 'pm-no-reading', '—'));
      face.setAttribute('aria-hidden', 'true');
    }
    face.append(scale, arc, center);
    return face;
  }
  function meter(w, now) {
    const s = M.windowState(w, now), row = el('div', 'pm-window'), labels = el('div', 'pm-window-label');
    row.dataset.level = s.level;
    const when = s.expired ? 'reset' : s.idle ? 'not started' : w.reset ? M.windowCaption(w, now).replace('Resets in ', 'resets ') : '';
    labels.append(el('span', '', w.label), el('b', '', s.left + '% left'));
    const bar = el('div', 'pm-track'), fill = el('i');
    fill.style.width = s.left + '%';
    bar.append(fill);
    row.append(labels, bar);
    if (when) row.append(el('small', 'pm-when', when));
    return row;
  }

  function accountCard(a, alias, now) {
    const card = el('section', 'pm-account'), status = M.accountStatus(a, now, context());
    card.dataset.provider = a.provider;
    card.setAttribute('aria-label', a.provider + ' · ' + (alias || a.name));
    card.append(identity(a, alias));
    const primary = status.reading ? M.primaryWindow(a.windows, now) : null, s = primary && M.windowState(primary, now);
    card.dataset.level = s?.level || 'none';
    const main = el('div', 'pm-instrument'), caption = el('div', 'pm-summary');
    main.append(dial(primary, now));
    if (primary) {
      caption.append(el('strong', 'pm-caption', primary.label + ' allowance'));
      const when = M.windowCaption(primary, now);
      if (when) caption.append(el('span', 'pm-reset', when));
      const ahead = M.paceText(M.pace(primary, now), primary.reset, now);
      if (ahead) {
        const line = el('span', 'pm-pace', ahead);
        line.dataset.warn = String(ahead.startsWith('At this pace'));
        caption.append(line);
      }
    } else {
      caption.append(el('strong', 'pm-caption', status.title));
      if (status.detail) caption.append(el('span', 'pm-reset pm-guidance', status.detail));
    }
    main.append(caption);
    card.append(main);
    const others = primary ? a.windows.filter(w => w !== primary && M.windowState(w, now)) : [];
    if (others.length) {
      const meters = el('div', 'pm-meters');
      for (const w of others.slice(0, 3)) meters.append(meter(w, now));
      card.append(meters);
    }
    const foot = el('div', 'pm-foot');
    if (status.reading) {
      const stamp = el('span', 'pm-stamp', status.title);
      stamp.dataset.tone = status.tone;
      if (status.detail) stamp.title = status.detail;
      foot.append(stamp);
    }
    for (const b of M.badges(a)) {
      const chip = el('span', 'pm-chip', b.text);
      chip.dataset.tone = b.tone;
      foot.append(chip);
    }
    if (foot.childElementCount) card.append(foot);
    if (status.reading && status.tone === 'warn' && status.detail) card.append(el('p', 'pm-stale', status.detail));
    return card;
  }

  function draw() {
    const now = Date.now(), visible = M.visibleAccounts(accounts(), prefs);
    const version = JSON.stringify([visible, prefs.names, !!snapshot, offline, Math.floor(now / 60000)]);
    if (version === drawn) return;
    drawn = version;
    // Keep the user's place in a row of accounts across live updates.
    const scroll = view.scrollLeft;
    view.replaceChildren();
    box.dataset.single = String(visible.length === 1);
    box.dataset.count = String(visible.length);
    if (!visible.length) {
      const empty = el('div', 'pm-empty');
      empty.append(el('strong', '', 'Account not on this Mac'), el('span', '', 'Choose accounts for this placement in Pages & layouts.'));
      view.append(empty);
    }
    for (const a of visible) view.append(accountCard(a, prefs.names?.[a.id], now));
    view.scrollLeft = scroll;
  }

  // Tell Dashledge which accounts this Mac has, for the placement's settings. Only when
  // the list or a status line changes, so an open settings sheet isn't redrawn every poll.
  function offer() {
    if (!snapshot) return;
    const options = M.accountOptions(accounts(), Date.now(), context());
    const key = JSON.stringify(options);
    if (key === offered) return;
    offered = key;
    host.settings.offer('accounts', options).catch(() => { offered = ''; });
  }

  window.plansSample = data => {
    if (!data || !Array.isArray(data.accounts)) return;
    snapshot = data;
    lastRead = Date.now();
    offline = false;
    draw();
    offer();
  };
  // The collector writes snapshot.js; a missing file means it hasn't finished its first pass.
  function load() {
    if (loading) return;
    loading = true;
    const script = el('script');
    const finish = () => {
      clearTimeout(timeout);
      script.remove();
      loading = false;
      if (snapshot && Date.now() - lastRead > OFFLINE_AFTER && !offline) { offline = true; draw(); offer(); }
    };
    const timeout = setTimeout(finish, 3000);
    script.onload = script.onerror = finish;
    script.src = 'snapshot.js?t=' + Date.now();
    document.head.append(script);
  }

  host.subscribe(state => {
    const s = state.settings || {};
    prefs = {accounts: Array.isArray(s.accounts) ? s.accounts : ['*'], names: s.names && typeof s.names === 'object' ? s.names : {}};
    draw();
  });
  // Check now in the placement's settings: read every account again.
  host.settings.onRefresh(() => host.command('refresh').catch(() => {}));
  load();
  setInterval(load, 5000);
  // Reset countdowns and "Updated 3m ago" move with the clock between readings.
  setInterval(() => { draw(); offer(); }, 15000);
})();
