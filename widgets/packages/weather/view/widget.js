// Weather view. The placement's settings name the location and units; the shared
// collector looks the place up and reads Open-Meteo. The view tells the collector which
// location it shows with the `watch` command, repeating it while it's on screen.
(() => {
  const M = globalThis.weatherModel;
  const host = window.Dashledge;
  const $ = id => document.getElementById(id);
  const box = $('weather'), hoursBox = $('hours');
  const HEARTBEAT = 60 * 1000;

  let snapshot = null, ready = false, query = '', unit = 'fahrenheit', loading = false, drawn = '';

  function el(tag, cls = '', text = '') {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  }
  function svgUse(cls, id) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    svg.setAttribute('class', cls);
    svg.setAttribute('aria-hidden', 'true');
    use.setAttribute('href', '#' + id);
    svg.append(use);
    return svg;
  }
  const setIcon = (svg, id) => svg.querySelector('use').setAttribute('href', '#w-' + id);

  let asked = 0;
  function watch(refresh = false) {
    if (!query) return;
    asked = Date.now();
    host.command('watch', {query, refresh}).catch(() => {});
  }

  function hourCell(h) {
    const cell = el('div', 'wx-hour');
    const temp = M.degrees(h.temp, unit), chance = M.precipText(h.precip);
    cell.setAttribute('role', 'listitem');
    cell.setAttribute('aria-label', M.hourLabel(h.time) + ', ' + temp + ', ' + (chance === '–' ? 'no precipitation forecast' : chance + ' chance of precipitation'));
    const precip = el('span', 'wx-precip');
    precip.dataset.level = typeof h.precip === 'number' ? (h.precip >= 50 ? 'high' : h.precip >= 20 ? 'some' : 'low') : 'none';
    precip.append(svgUse('wx-drop', 'i-drop'), el('span', '', chance));
    cell.append(el('span', 'wx-hour-time', M.hourLabel(h.time)), svgUse('wx-hour-icon', 'w-' + M.icon(h.kind, h.isDay)),
      el('span', 'wx-hour-temp', temp), precip);
    return cell;
  }

  function draw() {
    if (!ready) return;
    const now = Date.now(), entry = snapshot?.places?.[M.keyOf(query)];
    const s = M.status(query, entry, now, {snapshotAt: snapshot?.at || 0});
    const version = JSON.stringify([query, unit, s, entry?.weather, entry?.place]);
    if (version === drawn) return;
    drawn = version;
    box.dataset.state = s.kind;
    const w = entry?.weather;
    const showing = !!w && (s.kind === 'ready' || s.kind === 'stale');
    $('message').hidden = showing;
    if (!showing) {
      $('message-title').textContent = s.title;
      $('message-detail').textContent = s.detail;
      const action = $('message-action');
      action.hidden = !s.action;
      action.textContent = s.action === 'settings' ? (s.kind === 'empty' ? 'Choose a location' : 'Change location') : 'Try again';
      action.dataset.action = s.action;
      hoursBox.replaceChildren();
      return;
    }
    const lines = M.placeLines(entry.place);
    // The place the user chose, as the geocoder named it; never a built-in city.
    $('place-name').textContent = host.displayName(lines.name);
    $('place-detail').textContent = lines.detail;
    setIcon($('now-icon'), M.icon(w.kind, w.isDay));
    const t = M.temperature(w.temp, unit);
    $('temp-value').textContent = t === null ? '–' : String(t);
    $('temp-unit').textContent = unit === 'celsius' ? '°C' : '°F';
    $('now-temp').setAttribute('aria-label', (t === null ? 'No reading' : t + (unit === 'celsius' ? ' degrees Celsius' : ' degrees Fahrenheit')) + ', ' + w.label);
    $('condition').textContent = w.label;
    $('feels').textContent = w.feelsLike === null ? '' : 'Feels like ' + M.degrees(w.feelsLike, unit);
    $('range').textContent = w.high === null || w.low === null ? '' : 'H ' + M.degrees(w.high, unit) + '  L ' + M.degrees(w.low, unit);
    const status = $('status');
    status.textContent = s.title + (s.detail ? ' · ' + s.detail : '');
    status.dataset.tone = s.kind === 'stale' ? 'warn' : '';
    // Keep the strip's scroll position across refreshes.
    const scroll = hoursBox.scrollLeft;
    hoursBox.setAttribute('role', 'list');
    hoursBox.replaceChildren(...w.hours.map(hourCell));
    hoursBox.scrollLeft = scroll;
  }

  window.weatherSample = data => {
    if (!data || typeof data.places !== 'object' || !data.places) return;
    snapshot = data;
    // The collector doesn't know this location yet (it restarted, or missed the first
    // request): ask again rather than wait for the next heartbeat.
    if (query && !data.places[M.keyOf(query)] && Date.now() - asked > 10000) watch();
    draw();
  };
  // The collector writes snapshot.js; a missing file means it hasn't written yet.
  function load() {
    if (loading) return;
    loading = true;
    const script = el('script');
    const finish = () => { clearTimeout(timeout); script.remove(); loading = false; };
    const timeout = setTimeout(finish, 3000);
    script.onload = script.onerror = finish;
    script.src = 'snapshot.js?t=' + Date.now();
    document.head.append(script);
  }

  $('message-action').addEventListener('click', event => {
    if (event.currentTarget.dataset.action === 'settings') host.settings.open().catch(() => {});
    else { watch(true); load(); }
  });
  $('gear').addEventListener('click', () => host.settings.open().catch(() => {}));

  host.subscribe(state => {
    // Readable text on and in the highlight, whatever colour this placement uses.
    document.documentElement.style.setProperty('--on-hi', M.onColor(state.theme?.accent));
    document.documentElement.style.setProperty('--hi-text', M.readable(state.theme?.accent) || 'var(--hi)');
    // The first call carries the SDK's defaults; wait for the placement's own settings
    // so a configured placement never flashes "Choose a location".
    if (!state.settings) return;
    const s = state.settings;
    const nextQuery = M.cleanQuery(s.location), nextUnit = M.units(s.units);
    const moved = nextQuery !== query;
    query = nextQuery;
    unit = nextUnit;
    ready = true;
    if (moved) { hoursBox.scrollLeft = 0; watch(); }
    draw();
  });
  load();
  setInterval(load, 5000);
  setInterval(watch, HEARTBEAT);
  // "Updated 3 min ago" moves with the clock between readings.
  setInterval(draw, 30000);
})();
