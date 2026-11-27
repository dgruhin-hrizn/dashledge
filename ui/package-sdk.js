// Dashledge package SDK. The widget host injects this script into every package
// view. Views run in a sandboxed frame with no access to the app, so everything
// they need from Dashledge arrives here by message from the dashboard:
//   state   theme, display name and instance details (window.Dashledge.subscribe)
//   touch   touches from the Edge, replayed as pointer events, scrolls and taps
//   blur    the page holding the view was hidden
//   reply   the answer to window.Dashledge.command()
//   metrics this Mac's readings, for views that declare mac.metrics
//   refresh Check now in the placement's settings, for views that declare settings.choices
// `window.Zurface` is the same object, for views written against that API.
(() => {
  const host = window.parent;
  if (host === window) return;
  const send = message => host.postMessage({dashledge: 1, ...message}, '*');
  let state = {instanceID: '', touchMode: false, displayName: '',
    theme: {mode: 'dark', primary: '#edf0e6', accent: '#f88d4f'}};
  const subscribers = new Set(), pending = new Map(), dataListeners = new Set(), metricListeners = new Set(), refreshListeners = new Set();
  let latest = null, metrics = null, metricsWanted = false;
  let nextId = 1;

  // --px-scale keeps px-authored sizes at their reference-canvas physical size
  // when the view renders natively: the factor the 1920 × 540 canvas was scaled by.
  function pxScale() {
    if (state.viewport !== 'native') return 1;
    const width = window.innerWidth, height = window.innerHeight, wide = width >= height;
    return Math.max(0.25, Math.min(width / (wide ? 1920 : 540), height / (wide ? 540 : 1920)));
  }
  function applyTheme() {
    const root = document.documentElement;
    root.style.setProperty('--text', state.theme.primary);
    root.style.setProperty('--accent', state.theme.accent);
    root.style.setProperty('--px-scale', String(pxScale()));
    root.dataset.viewport = state.viewport || 'reference';
  }
  window.addEventListener('resize', () => applyTheme());

  const api = {
    subscribe(callback) {
      subscribers.add(callback);
      callback(state);
      return () => subscribers.delete(callback);
    },
    // Ask the host to run a command the package's manifest declares.
    command(name, args) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, {resolve, reject});
        send({type: 'command', id, name, args});
      });
    },
  };
  // Data from the package's declarative polls or connector: {rev, data, error}.
  api.onData = callback => {
    dataListeners.add(callback);
    if (latest) callback(latest);
    return () => dataListeners.delete(callback);
  };
  // The name to show for this placement's server: the user's name for the
  // connection, else the name the server reports, else the address's host.
  api.displayName = serverName => state.displayName || String(serverName || state.serverName || '').trim() || state.host || '';
  // Run an action the manifest declares, with values for its {placeholders}.
  api.action = (id, args = {}) => api.command('action', {id, args});

  // ---- Capabilities: each works only when the manifest's permissions declare it ----
  // settings: this placement's values, also in subscribe() state; open() shows the
  // same editor as Pages & layouts and resolves with the saved values or null.
  api.settings = {
    get values() { return {...(state.settings || {})}; },
    open: () => api.command('settings.open'),
    // settings.choices: the options this view found for one of its dynamic settings,
    // as [{value, label, detail?}]. Settings editors list the latest offer.
    offer: (setting, options) => api.command('settings.offer', {setting, options}),
    // Called when someone taps Check now in this placement's settings.
    onRefresh(callback) {
      refreshListeners.add(callback);
      return () => refreshListeners.delete(callback);
    },
  };
  // reminders (bundled widgets only): Apple Reminders through EventKit. read() returns
  // {permission: 'allowed'|'request'|'denied', lists, defaultList, items}; request: true
  // asks macOS once, while the widget is on screen. Changes resolve with {ok, item}.
  api.reminders = {
    read: ({request = false} = {}) => api.command('reminders.read', {request: request === true}),
    setCompleted: (id, completed) => api.command('reminders.complete', {id, completed: !!completed}),
    add: (title, {list = ''} = {}) => api.command('reminders.add', {title, list}),
    openPrivacy: () => api.command('reminders.privacy'),
  };
  // images: an image the manifest's `images` patterns allow, from the connection or a
  // declared host. Resolves with a blob: URL for <img src> or CSS. The same path reuses
  // its URL; `{fresh: true}` fetches again (a camera snapshot) and revokes the old one.
  const images = new Map();
  api.image = (path, options = {}) => {
    const key = String(path);
    const known = images.get(key);
    if (known && !options.fresh) return known;
    const next = api.command('image', {path: key, fresh: options.fresh === true})
      .then(({type, bytes}) => URL.createObjectURL(new Blob([bytes], {type})));
    images.set(key, next);
    next.then(() => known?.then(url => URL.revokeObjectURL(url)).catch(() => {}),
      () => { if (images.get(key) === next) images.delete(key); });
    return next;
  };
  // keyboard: the shared touch keyboard. Resolves with the text, or null when closed.
  api.keyboard = {open: (options = {}) => api.command('keyboard.open', options)};
  // mac.metrics: this Mac's CPU, GPU, memory and network readings, about once a second.
  function emitMetrics(next) {
    metrics = next;
    for (const callback of metricListeners) callback(next);
  }
  api.mac = {
    metrics: () => api.command('mac.metrics'),
    onMetrics(callback) {
      metricListeners.add(callback);
      if (metrics) callback(metrics);
      if (!metricsWanted) {
        metricsWanted = true;
        api.command('mac.subscribe').then(first => { if (first && !metrics) emitMetrics(first); })
          .catch(error => { metricsWanted = false; console.warn('Dashledge: mac.metrics', error.message); });
      }
      return () => metricListeners.delete(callback);
    },
  };
  window.Dashledge = api;
  window.Zurface = api;

  // ---- Touch: the same distance, direction and scroll rules as ui/touch.js ----
  const slop = 12;
  let gesture;
  const interactive = 'button,a,label,summary,[role=button],input,textarea';
  function scroller(target, axis) {
    for (let node = target; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      const vertical = axis === 'y';
      if (/(auto|scroll)/.test(vertical ? style.overflowY : style.overflowX) &&
          (vertical ? node.scrollHeight > node.clientHeight : node.scrollWidth > node.clientWidth)) return node;
    }
  }
  function pointer(type, target, x, y) {
    target?.dispatchEvent(new PointerEvent(type, {bubbles: true, cancelable: true, pointerId: 1,
      pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, buttons: type === 'pointerdown' ? 1 : 0}));
  }
  function rangeTouch(range, x, commit) {
    const rect = range.getBoundingClientRect();
    if (rect.width <= 0) return;
    const fraction = Math.min(1, Math.max(0, (x - rect.left) / rect.width));
    const min = Number(range.min), max = Number(range.max), step = Number(range.step) || 1;
    range.value = min + Math.round(fraction * (max - min) / step) * step;
    range.dispatchEvent(new Event('input', {bubbles: true}));
    if (commit) range.dispatchEvent(new Event('change', {bubbles: true}));
  }
  function decide(g, x, y) {
    const dx = x - g.x, dy = y - g.y;
    if (g.axis || Math.hypot(dx, dy) <= slop) return;
    g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    g.pressed?.classList.remove('edge-pressed');
    const room = dx < 0 ? g.left < g.max - 1 : g.left > 1;
    // Tell the dashboard whether this horizontal drag belongs to the page.
    g.page = g.axis === 'x' && !g.blocked && (g.bezel || !g.scrollX || !room);
    send({type: 'gesture', page: g.page});
  }
  function touch(kind, x, y, message) {
    if (kind === 'down') {
      const target = document.elementFromPoint(x, y);
      const pressed = target?.closest(interactive);
      pressed?.classList.add('edge-pressed');
      const scrollX = scroller(target, 'x');
      gesture = {target, pressed, x, y, lastX: x, lastY: y, scrollX, scrollY: scroller(target, 'y'),
        left: scrollX?.scrollLeft || 0, max: scrollX ? scrollX.scrollWidth - scrollX.clientWidth : 0,
        bezel: !!message.bezel, blocked: !!(target?.closest('input,textarea,select,[contenteditable=true]') ||
          document.querySelector('dialog[open]'))};
      if (pressed?.matches('input[type=range][data-edge-range]') && !pressed.disabled) {
        gesture.range = pressed;
        rangeTouch(pressed, x, false);
        return;
      }
      pointer('pointerdown', target, x, y);
      return;
    }
    const g = gesture;
    if (!g) return;
    if (g.range) {
      if (g.range.isConnected && !g.range.disabled) rangeTouch(g.range, x, kind === 'up');
      if (kind === 'up') { g.range.classList.remove('edge-pressed'); gesture = null; }
      return;
    }
    decide(g, x, y);
    if (kind === 'move') {
      if (g.axis === 'x' && !g.page) g.scrollX?.scrollBy(g.lastX - x, 0);
      if (g.axis === 'y') g.scrollY?.scrollBy(0, g.lastY - y);
      g.lastX = x; g.lastY = y;
      return;
    }
    gesture = null;
    g.pressed?.classList.remove('edge-pressed');
    if (message.turned) { pointer('pointercancel', g.target, x, y); return; }
    const target = document.elementFromPoint(x, y) || g.target;
    pointer('pointerup', target, x, y);
    if (g.axis || !target?.isConnected) return;
    const released = target.closest(interactive);
    if (g.pressed !== released) return;
    // A tap on blank background at the left edge opens the page picker.
    if (message.edge && !released && ['BODY', 'HTML', 'MAIN'].includes(target.tagName) &&
        !document.querySelector('dialog[open]')) {
      send({type: 'pagepicker'});
      return;
    }
    const field = target.closest('input,textarea,[contenteditable=true]');
    if (field) { send({type: 'focus-window'}); field.focus(); }
    const options = {bubbles: true, cancelable: true, clientX: x, clientY: y, view: window};
    for (const type of ['mousedown', 'mouseup']) target.dispatchEvent(new MouseEvent(type, options));
    if (typeof target.click === 'function') target.click();
    else target.dispatchEvent(new MouseEvent('click', options));
  }

  // Mouse and trackpad input in the preview window: same page-swipe rules.
  let browser, suppressClick = false;
  document.addEventListener('pointerdown', e => {
    if (!e.isTrusted || !e.isPrimary || e.button !== 0) return;
    suppressClick = false;
    const scrollX = scroller(e.target, 'x');
    browser = {id: e.pointerId, x: e.clientX, y: e.clientY, scrollX,
      left: scrollX?.scrollLeft || 0, max: scrollX ? scrollX.scrollWidth - scrollX.clientWidth : 0,
      bezel: e.clientX <= 24 || e.clientX >= innerWidth - 24,
      blocked: !!(e.target.closest('input,textarea,select,[contenteditable=true]') || document.querySelector('dialog[open]'))};
  }, true);
  document.addEventListener('pointermove', e => {
    if (e.isTrusted && browser?.id === e.pointerId) decideBrowser(browser, e.clientX, e.clientY);
  }, true);
  function decideBrowser(g, x, y) {
    const dx = x - g.x, dy = y - g.y;
    if (g.axis || Math.hypot(dx, dy) <= slop) return;
    g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    const room = dx < 0 ? g.left < g.max - 1 : g.left > 1;
    g.page = g.axis === 'x' && !g.blocked && (g.bezel || !g.scrollX || !room);
  }
  document.addEventListener('pointerup', e => {
    const g = browser;
    if (!e.isTrusted || !g || g.id !== e.pointerId) return;
    browser = null;
    decideBrowser(g, e.clientX, e.clientY);
    const dx = e.clientX - g.x, threshold = Math.max(48, Math.min(96, innerWidth * 0.05));
    if (g.page && Math.abs(dx) >= threshold && Math.abs(dx) >= Math.abs(e.clientY - g.y) * 1.4) {
      suppressClick = true;
      send({type: 'swipe', step: dx < 0 ? 1 : -1});
    }
  }, true);
  document.addEventListener('pointercancel', e => { if (e.isTrusted) browser = null; }, true);
  document.addEventListener('click', e => {
    if (e.isTrusted && suppressClick) { suppressClick = false; e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  document.addEventListener('keydown', e => {
    if (e.altKey && e.code === 'KeyP') { e.preventDefault(); send({type: 'pagepicker'}); }
  });
  window.addEventListener('contextmenu', event => event.preventDefault());

  window.addEventListener('message', e => {
    if (e.source !== host || e.data?.dashledge !== 1) return;
    const message = e.data;
    if (message.type === 'state') {
      state = {...state, ...message.state};
      applyTheme();
      for (const callback of subscribers) callback(state);
    } else if (message.type === 'touch') {
      touch(message.kind, message.x, message.y, message);
    } else if (message.type === 'data') {
      latest = {rev: message.rev, data: message.data, error: message.error ?? null};
      for (const callback of dataListeners) callback(latest);
    } else if (message.type === 'metrics') {
      emitMetrics(message.metrics);
    } else if (message.type === 'refresh') {
      for (const callback of refreshListeners) callback();
    } else if (message.type === 'blur') {
      window.dispatchEvent(new Event('blur'));
    } else if (message.type === 'reply') {
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error));
      else waiting.resolve(message.value);
    }
  });
  applyTheme();
  send({type: 'ready'});
})();
