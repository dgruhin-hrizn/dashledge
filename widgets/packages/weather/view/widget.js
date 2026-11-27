// Weather view. The placement's settings name the location, units and what to show; the
// shared collector looks the place up and reads Open-Meteo. The view tells the collector
// which location it shows with the `watch` command, repeating it while it's on screen.
//
// Each size gets its own composition (model.layout): the whole Edge shows the hero, a
// 24-hour curve, instruments and the week; smaller placements pick what fits.
(() => {
  const M = globalThis.weatherModel;
  const host = window.Dashledge;
  const $ = id => document.getElementById(id);
  const box = $('weather'), chart = $('chart'), daysBox = $('days'), details = $('details');
  const HEARTBEAT = 60 * 1000;
  const SVG = 'http://www.w3.org/2000/svg';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  let snapshot = null, ready = false, query = '', unit = 'fahrenheit', show = 'auto', loading = false, drawn = '';
  let current = {mode: 'wide', panels: ['hourly']};

  function el(tag, cls = '', text = '') {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  }
  function svg(tag, attrs = {}, text = '') {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text) node.textContent = text;
    return node;
  }
  function icon(cls, id) {
    const s = svg('svg', {class: cls, 'aria-hidden': 'true'});
    s.append(svg('use', {href: '#' + id}));
    return s;
  }
  const setIcon = (node, id) => node.querySelector('use').setAttribute('href', '#w-' + id);
  const scale = () => Number(getComputedStyle(document.documentElement).getPropertyValue('--px-scale')) || 1;

  let asked = 0;
  function watch(refresh = false) {
    if (!query) return;
    asked = Date.now();
    host.command('watch', {query, refresh}).catch(() => {});
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  function relayout() {
    const s = scale();
    const next = M.layout(innerWidth / s, innerHeight / s, show);
    const changed = next.mode !== current.mode || next.panels.join() !== current.panels.join();
    current = next;
    box.dataset.mode = next.mode;
    box.dataset.panels = next.panels.join(' ');
    return changed;
  }

  // ── Hourly curve ────────────────────────────────────────────────────────
  // All SVG in CSS px, so text stays crisp at the native viewport.
  function drawChart(w) {
    chart.replaceChildren();
    const {width, height} = chart.getBoundingClientRect();
    if (width < 50 || height < 50 || !w.hours.length) return;
    const s = scale(), mini = current.mode === 'strip';
    const count = mini || width < 700 * s ? 12 : 24;
    const hours = w.hours.slice(0, count);
    const temps = hours.map(h => h.temp).concat(w.temp);
    const min = Math.min(...temps), max = Math.max(...temps), spread = Math.max(max - min, 3);
    const pad = 22 * s, iconRow = mini ? 0 : 34 * s, labelRow = 26 * s, hourRow = 24 * s, rainBand = mini ? 0 : 30 * s;
    const top = iconRow + labelRow + 6 * s, bottom = height - hourRow - rainBand - 10 * s;
    const x = i => pad + (width - pad * 2) * (i / count);
    const y = t => bottom - (bottom - top) * ((t - min + (spread - (max - min)) / 2) / spread);
    const points = [[x(0), y(w.temp)], ...hours.map((h, i) => [x(i + 1), y(h.temp)])];
    const line = M.smoothPath(points);
    const root = svg('svg', {viewBox: `0 0 ${width} ${height}`, width, height, role: 'img',
      'aria-label': 'Next ' + count + ' hours: ' + hours.filter((_, i) => i % 3 === 2).map(h => M.hourLabel(h.time) + ' ' + M.degrees(h.temp, unit)).join(', ')});
    const defs = svg('defs');
    const stroke = svg('linearGradient', {id: 'curve-stroke', gradientUnits: 'userSpaceOnUse', x1: 0, y1: top, x2: 0, y2: bottom});
    stroke.append(svg('stop', {offset: 0, 'stop-color': M.tempColor(max)}), svg('stop', {offset: 1, 'stop-color': M.tempColor(min)}));
    const fill = svg('linearGradient', {id: 'curve-fill', x1: 0, y1: 0, x2: 0, y2: 1});
    fill.append(svg('stop', {offset: 0, 'stop-color': M.tempColor(max), 'stop-opacity': .38}), svg('stop', {offset: 1, 'stop-color': M.tempColor(min), 'stop-opacity': 0}));
    const rain = svg('linearGradient', {id: 'rain-fill', x1: 0, y1: 0, x2: 0, y2: 1});
    rain.append(svg('stop', {offset: 0, 'stop-color': '#7cc4ff', 'stop-opacity': .9}), svg('stop', {offset: 1, 'stop-color': '#3f8cff', 'stop-opacity': .25}));
    defs.append(stroke, fill, rain);
    root.append(defs);
    // Faint hour grid, then rain chance as bars, the filled area and the line.
    const step = Math.max(1, Math.ceil(count / Math.max(4, Math.floor((width - pad * 2) / (78 * s)))));
    hours.forEach((h, i) => {
      const cx = x(i + 1);
      if ((i + 1) % step === 0) root.append(svg('line', {x1: cx, x2: cx, y1: top - 4 * s, y2: bottom, class: 'wx-grid'}));
      if (rainBand && typeof h.precip === 'number' && h.precip > 0) {
        const bh = Math.max(2 * s, (rainBand - 4 * s) * h.precip / 100), bw = Math.max(3 * s, (width - pad * 2) / count * .46);
        root.append(svg('rect', {x: cx - bw / 2, y: bottom + 8 * s + rainBand - bh, width: bw, height: bh, rx: Math.min(bw / 2, 3 * s), fill: 'url(#rain-fill)'}));
      }
    });
    root.append(svg('path', {d: line + ` L${points.at(-1)[0]} ${bottom} L${points[0][0]} ${bottom} Z`, fill: 'url(#curve-fill)'}));
    root.append(svg('path', {d: line, class: 'wx-curve', stroke: 'url(#curve-stroke)', 'stroke-width': 3.5 * s}));
    // Labels every few hours: icon, temperature above the line, hour and rain below.
    hours.forEach((h, i) => {
      if ((i + 1) % step) return;
      const [cx, cy] = points[i + 1];
      root.append(svg('circle', {cx, cy, r: 3.5 * s, fill: M.tempColor(h.temp), class: 'wx-point'}));
      root.append(svg('text', {x: cx, y: cy - 12 * s, class: 'wx-t-temp'}, M.degrees(h.temp, unit)));
      if (iconRow) {
        const u = svg('use', {href: '#w-' + M.icon(h.kind, h.isDay), x: cx - 15 * s, y: 2 * s, width: 30 * s, height: 30 * s});
        root.append(u);
      }
      root.append(svg('text', {x: cx, y: height - 6 * s, class: 'wx-t-hour'}, M.hourLabel(h.time)));
      if (rainBand && typeof h.precip === 'number' && h.precip >= 20)
        root.append(svg('text', {x: cx, y: bottom + 8 * s + rainBand - Math.max(2 * s, (rainBand - 4 * s) * h.precip / 100) - 4 * s, class: 'wx-t-rain'}, Math.round(h.precip) + '%'));
    });
    // Now: a glowing dot where the line starts.
    const [nx, ny] = points[0];
    root.append(svg('circle', {cx: nx, cy: ny, r: 11 * s, class: 'wx-now-halo'}), svg('circle', {cx: nx, cy: ny, r: 5.5 * s, class: 'wx-now-dot'}));
    root.append(svg('text', {x: nx, y: height - 6 * s, class: 'wx-t-hour wx-t-now'}, 'Now'));
    chart.append(root);
  }

  // ── Week ────────────────────────────────────────────────────────────────
  function drawWeek(w) {
    const days = w.days || [];
    const today = String(w.time).slice(0, 10);
    const min = Math.min(...days.map(d => d.low)), max = Math.max(...days.map(d => d.high));
    daysBox.replaceChildren(...days.map(d => {
      const row = el('li', 'wx-day');
      const name = M.dayLabel(d.date, today);
      row.setAttribute('aria-label', name + ', ' + d.kind + ', low ' + M.degrees(d.low, unit) + ', high ' + M.degrees(d.high, unit) +
        (typeof d.precip === 'number' ? ', ' + Math.round(d.precip) + '% chance of precipitation' : ''));
      const rain = el('span', 'wx-day-rain');
      if (typeof d.precip === 'number' && d.precip >= 20) rain.append(icon('wx-drop', 'i-drop'), el('span', '', Math.round(d.precip) + '%'));
      const bar = el('span', 'wx-bar');
      const fill = el('i');
      const {from, to} = M.span(d.low, d.high, min, max);
      fill.style.left = from * 100 + '%';
      fill.style.right = (1 - to) * 100 + '%';
      fill.style.background = `linear-gradient(90deg, ${M.tempColor(d.low)}, ${M.tempColor(d.high)})`;
      bar.append(fill);
      if (d.date === today && typeof w.temp === 'number') {
        const dot = el('b');
        dot.style.left = M.span(w.temp, w.temp, min, max).from * 100 + '%';
        bar.append(dot);
      }
      row.append(el('span', 'wx-day-name', name), icon('wx-day-icon', 'w-' + M.icon(d.kind, true)), rain,
        el('span', 'wx-lo', M.degrees(d.low, unit)), bar, el('span', 'wx-hi', M.degrees(d.high, unit)));
      if (d.date === today) row.dataset.today = 'true';
      return row;
    }));
    // Show only the days that fit whole.
    requestAnimationFrame(() => {
      const limit = daysBox.getBoundingClientRect().bottom + 1;
      for (const row of daysBox.children) row.hidden = false;
      for (const row of daysBox.children) if (row.getBoundingClientRect().bottom > limit) row.hidden = true;
    });
  }

  // ── Instruments: sun, wind, humidity, UV ───────────────────────────────
  function tile(name, label) {
    const t = el('article', 'wx-tile wx-' + name);
    t.append(el('h3', 'wx-label', label));
    return t;
  }
  function drawDetails(w) {
    const today = (w.days || [])[0] || {};
    const tiles = [];
    // Sun: an arc from sunrise to sunset with the sun where it is now.
    if (today.sunrise && today.sunset) {
      const p = M.sunProgress(w.time, today.sunrise, today.sunset);
      const up = p !== null && p >= 0 && p <= 1;
      const t = tile('sun', up ? 'Sunset' : 'Sunrise');
      t.append(el('strong', 'wx-tile-value', up ? M.clock(today.sunset) : M.clock((w.days[1] && p > 1 ? w.days[1] : today).sunrise)));
      const arc = svg('svg', {viewBox: '0 0 120 64', class: 'wx-sun-arc', 'aria-hidden': 'true'});
      arc.append(svg('path', {d: 'M8 58 A52 52 0 0 1 112 58', class: 'wx-arc-track'}));
      if (up) {
        const a = Math.PI * (1 - p), sx = 60 + 52 * Math.cos(a), sy = 58 - 52 * Math.sin(a);
        arc.append(svg('path', {d: `M8 58 A52 52 0 0 1 ${sx.toFixed(1)} ${sy.toFixed(1)}`, class: 'wx-arc-done'}));
        arc.append(svg('circle', {cx: sx, cy: sy, r: 9, class: 'wx-sun-glow'}), svg('circle', {cx: sx, cy: sy, r: 5, class: 'wx-sun-dot'}));
      }
      arc.append(svg('line', {x1: 0, x2: 120, y1: 58, y2: 58, class: 'wx-horizon'}));
      t.append(arc, el('span', 'wx-tile-note', up ? 'Rose ' + M.clock(today.sunrise) : 'Set ' + M.clock(today.sunset)));
      tiles.push(t);
    }
    // Wind: a compass with the arrow pointing where the wind blows.
    const speed = M.windSpeed(w.wind, unit);
    if (speed) {
      const t = tile('wind', 'Wind');
      const dial = el('div', 'wx-compass');
      const arrow = svg('svg', {viewBox: '0 0 64 64', class: 'wx-compass-ring', 'aria-hidden': 'true'});
      arrow.append(svg('circle', {cx: 32, cy: 32, r: 29, class: 'wx-ring'}));
      for (let i = 0; i < 36; i++) {
        const a = i * Math.PI / 18, r1 = i % 9 ? 26 : 23;
        arrow.append(svg('line', {x1: 32 + 29 * Math.sin(a), y1: 32 - 29 * Math.cos(a), x2: 32 + r1 * Math.sin(a), y2: 32 - r1 * Math.cos(a), class: 'wx-tick'}));
      }
      arrow.append(svg('text', {x: 32, y: 15, class: 'wx-n'}, 'N'));
      if (typeof w.windFrom === 'number') {
        const g = svg('g', {transform: `rotate(${w.windFrom + 180} 32 32)`});
        g.append(svg('path', {d: 'M32 10 L37 22 L32 19 L27 22 Z', class: 'wx-arrow'}), svg('line', {x1: 32, y1: 19, x2: 32, y2: 50, class: 'wx-arrow-tail'}));
        arrow.append(g);
      }
      const center = el('span', 'wx-compass-value');
      center.append(el('b', '', String(speed.value)), el('small', '', speed.unit));
      dial.append(arrow, center);
      const gust = M.windSpeed(w.gusts, unit);
      t.append(dial, el('span', 'wx-tile-note', [M.compass(w.windFrom) && 'From ' + M.compass(w.windFrom), gust && 'gusts ' + gust.value].filter(Boolean).join(' · ')));
      tiles.push(t);
    }
    if (typeof w.humidity === 'number') {
      const t = tile('humidity', 'Humidity');
      const h = Math.round(w.humidity);
      t.append(el('strong', 'wx-tile-value', h + '%'));
      const bar = el('span', 'wx-meter'), fill = el('i');
      fill.style.width = h + '%';
      bar.append(fill);
      t.append(bar, el('span', 'wx-tile-note', h < 30 ? 'Dry' : h < 60 ? 'Comfortable' : h < 80 ? 'Humid' : 'Very humid'));
      tiles.push(t);
    }
    const uv = typeof w.uv === 'number' ? w.uv : today.uv;
    if (typeof uv === 'number') {
      const t = tile('uv', 'UV index');
      t.append(el('strong', 'wx-tile-value', String(Math.round(uv))));
      const bar = el('span', 'wx-meter wx-uv-scale'), dot = el('b');
      dot.style.left = Math.min(100, uv / 11 * 100) + '%';
      bar.append(dot);
      t.append(bar, el('span', 'wx-tile-note', M.uvLevel(uv) + (today.uv != null && w.isDay ? ' · peak ' + Math.round(today.uv) : '')));
      tiles.push(t);
    }
    details.replaceChildren(...tiles);
  }

  // ── Sky effects: rain, snow, stars, lightning ──────────────────────────
  const canvas = $('fx'), ctx = canvas.getContext('2d');
  let particles = [], fxKind = '', frame = 0, last = 0, flash = 0;
  function seed(kind) {
    fxKind = kind;
    const w = canvas.width, h = canvas.height, area = w * h / 1e6;
    const rnd = (a, b) => a + Math.random() * (b - a);
    const n = kind.startsWith('rain') ? (kind.includes('drizzle') ? 50 : 110) * area : kind === 'storm' ? 140 * area
      : kind.startsWith('snow') ? 90 * area : kind.endsWith('night') ? 70 * area : 0;
    particles = Array.from({length: Math.min(260, Math.round(n))}, () => ({x: rnd(0, w), y: rnd(0, h), v: rnd(.6, 1.4), r: rnd(.4, 1), p: rnd(0, 6.28)}));
  }
  function paint(t) {
    const w = canvas.width, h = canvas.height, d = devicePixelRatio || 1, still = reduced.matches;
    ctx.clearRect(0, 0, w, h);
    const k = fxKind;
    if (k.startsWith('rain') || k === 'storm') {
      ctx.strokeStyle = 'rgba(170,205,255,.32)';
      ctx.lineWidth = 1.2 * d;
      ctx.beginPath();
      for (const p of particles) {
        if (!still) { p.y += 14 * p.v * d; p.x -= 3 * p.v * d; if (p.y > h) { p.y = -20 * d; p.x = Math.random() * w * 1.1; } }
        ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + 3.5 * d, p.y - 16 * p.v * d);
      }
      ctx.stroke();
    } else if (k.startsWith('snow')) {
      ctx.fillStyle = 'rgba(255,255,255,.75)';
      for (const p of particles) {
        if (!still) { p.y += 1.1 * p.v * d; p.x += Math.sin(t / 1400 + p.p) * .5 * d; if (p.y > h) { p.y = -6 * d; p.x = Math.random() * w; } }
        ctx.beginPath(); ctx.arc(p.x, p.y, (1.2 + p.r * 2) * d, 0, 6.29); ctx.fill();
      }
    } else if (k.endsWith('night')) {
      // Stars in the upper sky only, twinkling slowly.
      for (const p of particles) {
        const a = still ? .5 : .25 + .45 * (1 + Math.sin(t / 900 * p.v + p.p)) / 2;
        ctx.fillStyle = `rgba(255,255,255,${a})`;
        ctx.beginPath(); ctx.arc(p.x, p.y * .55, p.r * 1.3 * d, 0, 6.29); ctx.fill();
      }
    }
    if (k === 'storm' && !still) {
      if (flash <= 0 && Math.random() < .004) flash = 1;
      if (flash > 0) { box.style.setProperty('--flash', String(flash)); flash = Math.max(0, flash - .06); if (!flash) box.style.setProperty('--flash', '0'); }
    }
  }
  function loop(t) {
    frame = 0;
    if (document.hidden || reduced.matches) return;
    if (t - last >= 33) { last = t; paint(t); }
    frame = requestAnimationFrame(loop);
  }
  function startFx(kind) {
    const r = canvas.getBoundingClientRect(), d = devicePixelRatio || 1;
    const w = Math.round(r.width * d), h = Math.round(r.height * d);
    const resized = canvas.width !== w || canvas.height !== h;
    if (resized) { canvas.width = w; canvas.height = h; }
    if (resized || kind !== fxKind) seed(kind);
    paint(performance.now());
    if (!frame && particles.length && !reduced.matches) frame = requestAnimationFrame(loop);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && fxKind) startFx(fxKind); });
  reduced.addEventListener?.('change', () => fxKind && startFx(fxKind));

  // ── Drawing ─────────────────────────────────────────────────────────────
  function draw(force = false) {
    if (!ready) return;
    const now = Date.now(), entry = snapshot?.places?.[M.keyOf(query)];
    const s = M.status(query, entry, now, {snapshotAt: snapshot?.at || 0});
    const version = JSON.stringify([query, unit, show, current, s, entry?.weather, entry?.place]);
    if (version === drawn && !force) return;
    drawn = version;
    box.dataset.state = s.kind;
    const w = entry?.weather;
    const showing = !!w && (s.kind === 'ready' || s.kind === 'stale');
    $('message').hidden = showing;
    if (!showing) {
      box.dataset.sky = 'cloudy-night';
      startFx('');
      $('message-title').textContent = s.title;
      $('message-detail').textContent = s.detail;
      const action = $('message-action');
      action.hidden = !s.action;
      action.textContent = s.action === 'settings' ? (s.kind === 'empty' ? 'Choose a location' : 'Change location') : 'Try again';
      action.dataset.action = s.action;
      chart.replaceChildren(); daysBox.replaceChildren(); details.replaceChildren();
      return;
    }
    const skyKind = M.sky(w.kind, w.isDay);
    box.dataset.sky = skyKind;
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
    // Today's range with where it is now.
    const range = $('today-range');
    range.hidden = w.high === null || w.low === null;
    if (!range.hidden) {
      $('lo').textContent = 'L ' + M.degrees(w.low, unit);
      $('hi').textContent = 'H ' + M.degrees(w.high, unit);
      $('today-fill').style.background = `linear-gradient(90deg, ${M.tempColor(w.low)}, ${M.tempColor(w.high)})`;
      $('today-dot').style.left = M.span(w.temp, w.temp, Math.min(w.low, w.temp), Math.max(w.high, w.temp)).from * 100 + '%';
    }
    const status = $('status');
    status.textContent = s.title + (s.detail ? ' · ' + s.detail : '');
    status.dataset.tone = s.kind === 'stale' ? 'warn' : '';
    if (current.panels.includes('hourly')) drawChart(w); else chart.replaceChildren();
    if (current.panels.includes('week')) drawWeek(w); else daysBox.replaceChildren();
    if (current.panels.includes('details')) drawDetails(w); else details.replaceChildren();
    startFx(skyKind);
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
  for (const id of ['gear', 'gear-corner']) $(id).addEventListener('click', () => host.settings.open().catch(() => {}));

  // A new size can mean a new composition, and the curve and dials redraw to fit.
  let resizeTimer = 0;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { relayout(); draw(true); }, 60);
  }).observe(box);

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
    show = ['hourly', 'week', 'now'].includes(s.show) ? s.show : 'auto';
    ready = true;
    relayout();
    if (moved) watch();
    draw(true);
  });
  load();
  setInterval(load, 5000);
  setInterval(watch, HEARTBEAT);
  // "Updated 3 min ago" moves with the clock between readings.
  setInterval(draw, 30000);
})();
