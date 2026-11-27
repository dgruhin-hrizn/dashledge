// Weather view model: pure functions the view and tests share. A classic script, since
// views load their files with <script>; it sets globalThis.weatherModel.
(() => {
  const MAX_QUERY = 80;
  // A forecast older than this is shown as stale: the collector refreshes every 10 minutes.
  const STALE_AFTER = 30 * 60 * 1000;
  // The collector rewrites its snapshot every 15 seconds; much longer means it stopped.
  const OFFLINE_AFTER = 60 * 1000;

  // The placement's location as the collector keys it: spaces tidied, at most 80 characters.
  function cleanQuery(value) {
    if (typeof value !== 'string') return '';
    const text = value.replace(/\s+/g, ' ').trim();
    if (!text || text.length > MAX_QUERY || /[\u0000-\u001f\u007f]/.test(text)) return '';
    return text;
  }
  const keyOf = query => cleanQuery(query).toLowerCase();
  const units = value => (value === 'celsius' ? 'celsius' : 'fahrenheit');

  // Open-Meteo reports °C with a decimal; convert, then round once.
  function temperature(celsius, unit) {
    if (typeof celsius !== 'number' || !Number.isFinite(celsius)) return null;
    const value = units(unit) === 'celsius' ? celsius : celsius * 9 / 5 + 32;
    const rounded = Math.round(value);
    return Object.is(rounded, -0) ? 0 : rounded;
  }
  const degrees = (celsius, unit) => {
    const t = temperature(celsius, unit);
    return t === null ? '–' : t + '°';
  };

  // "2026-11-06T14:00", the location's own local time, as "2 PM".
  function hourLabel(time) {
    const h = Number(String(time).slice(11, 13));
    if (!Number.isInteger(h) || h < 0 || h > 23) return '';
    return (h % 12 || 12) + (h < 12 ? ' AM' : ' PM');
  }
  const precipText = p => (typeof p === 'number' && Number.isFinite(p) ? Math.round(p) + '%' : '–');

  function ago(at, now) {
    const minutes = Math.max(0, Math.floor((now - at) / 60000));
    if (minutes < 1) return 'Updated just now';
    if (minutes < 60) return 'Updated ' + minutes + ' min ago';
    const hours = Math.floor(minutes / 60);
    return 'Updated ' + hours + (hours === 1 ? ' hour ago' : ' hours ago');
  }

  // The place's name and the line under it: "Illinois · United States".
  function placeLines(place) {
    if (!place) return {name: '', detail: ''};
    const detail = [place.region, place.country].filter(Boolean).join(' · ');
    return {name: String(place.name || ''), detail};
  }

  // What this placement shows. kind: empty | loading | notfound | failed | ready | stale.
  // `action` names the button the view offers: settings or retry.
  function status(query, entry, now, {snapshotAt = 0} = {}) {
    const q = cleanQuery(query);
    if (!q) return {kind: 'empty', title: 'Choose a location', detail: 'Type a city, such as Chicago or Paris, France.', action: 'settings'};
    const offline = snapshotAt > 0 && now - snapshotAt > OFFLINE_AFTER;
    if (!entry || (entry.state === 'loading' && !entry.weather)) {
      return offline
        ? {kind: 'failed', title: 'Weather isn’t updating', detail: 'The weather service in Dashledge stopped.', action: 'retry'}
        : {kind: 'loading', title: 'Finding ' + q + '…', detail: '', action: ''};
    }
    if (entry.state === 'notfound') {
      return {kind: 'notfound', title: 'No place called “' + q + '”', detail: 'Check the spelling, or add a region: Portland, OR.', action: 'settings'};
    }
    if (!entry.weather) {
      return {kind: 'failed', title: 'Weather unavailable', detail: entry.error || 'Open-Meteo didn’t answer.', action: 'retry'};
    }
    const old = !entry.at || now - entry.at > STALE_AFTER;
    if (old || offline || entry.state === 'error') {
      // Still the last good forecast, marked with when it was read.
      const stale = old || offline;
      return {kind: stale ? 'stale' : 'ready', title: ago(entry.at, now), detail: stale ? 'Couldn’t refresh: ' + (entry.error || 'no answer') : '', action: stale ? 'retry' : ''};
    }
    return {kind: 'ready', title: ago(entry.at, now), detail: '', action: ''};
  }

  // The icon to draw: clear and partly cloudy skies have a night version.
  function icon(kind, isDay) {
    const k = ['clear', 'partly', 'cloudy', 'fog', 'drizzle', 'rain', 'snow', 'storm'].includes(kind) ? kind : 'cloudy';
    return (k === 'clear' || k === 'partly') && isDay === false ? k + '-night' : k;
  }

  // Colour helpers for the Dashledge highlight, which the user (or a placement) picks.
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
  // Text on a filled highlight: near-black or white, whichever contrasts more (WCAG).
  function onColor(hex) {
    const c = rgb(hex);
    if (!c) return '#0b1019';
    const l = luminance(c);
    return (l + 0.05) / (luminance([11, 16, 25]) + 0.05) >= 1.05 / (l + 0.05) ? '#0b1019' : '#ffffff';
  }
  // The highlight used as text on the dark background: itself when it reads at 4.5:1,
  // else mixed toward white just until it does, keeping its hue.
  function readable(hex) {
    const c = rgb(hex);
    if (!c) return '';
    const base = luminance([11, 16, 25]);
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const mixed = c.map(v => Math.round(v + (255 - v) * t));
      if ((luminance(mixed) + 0.05) / (base + 0.05) >= 4.5) return '#' + mixed.map(v => v.toString(16).padStart(2, '0')).join('');
    }
    return '#ffffff';
  }

  // ── Layout: which composition and panels a placement gets ────────────────
  // w and h are in reference-canvas px (CSS px ÷ --px-scale). `show` is the setting.
  //   full   the whole Edge: hero, 24-hour curve, instruments, week
  //   wide   a wide tile: hero beside the curve (plus instruments when there's room)
  //   tall   a column: hero over the week (or the curve)
  //   strip  a short band: hero in a row with a mini curve or the next days
  //   tiny   just the reading
  function layout(w, h, show = 'auto') {
    const pick = (auto, choices) => (show !== 'auto' && choices[show]) || auto;
    if (w < 300 || h < 170) return {mode: 'tiny', panels: []};
    if (h < 330) return {mode: 'strip', panels: w < 520 ? [] : pick(['hourly'], {hourly: ['hourly'], week: ['week'], now: []})};
    if (w < 900) return {mode: 'tall', panels: pick(['week'], {hourly: ['hourly'], week: ['week'], now: []})};
    if (w < 1700) {
      const room = w >= 1150;
      return {mode: 'wide', panels: pick(room ? ['hourly', 'details'] : ['hourly'],
        {hourly: room ? ['hourly', 'details'] : ['hourly'], week: room ? ['week', 'details'] : ['week'], now: room ? ['details'] : []})};
    }
    return {mode: 'full', panels: pick(['hourly', 'details', 'week'],
      {hourly: ['hourly', 'details'], week: ['week', 'details'], now: ['details']})};
  }

  // ── Sky: the backdrop for the current condition, day or night ───────────
  function sky(kind, isDay) {
    if (kind === 'storm') return 'storm';
    if (kind === 'snow') return isDay ? 'snow-day' : 'snow-night';
    if (kind === 'rain' || kind === 'drizzle') return isDay ? 'rain-day' : 'rain-night';
    if (kind === 'fog') return isDay ? 'fog-day' : 'fog-night';
    if (kind === 'cloudy') return isDay ? 'cloudy-day' : 'cloudy-night';
    return (kind === 'partly' ? 'partly-' : 'clear-') + (isDay === false ? 'night' : 'day');
  }

  // A temperature (°C) as a colour on one scale for every view: icy blue to hot red.
  const STOPS = [[-15, [146, 120, 255]], [-5, [110, 170, 255]], [5, [90, 214, 230]], [14, [120, 228, 150]],
    [21, [255, 214, 102]], [28, [255, 150, 70]], [36, [255, 84, 84]]];
  function tempColor(celsius) {
    if (typeof celsius !== 'number' || !Number.isFinite(celsius)) return '#9aa4b4';
    if (celsius <= STOPS[0][0]) return hex(STOPS[0][1]);
    for (let i = 1; i < STOPS.length; i++) {
      const [t1, c1] = STOPS[i], [t0, c0] = STOPS[i - 1];
      if (celsius <= t1) { const f = (celsius - t0) / (t1 - t0); return hex(c0.map((v, j) => v + (c1[j] - v) * f)); }
    }
    return hex(STOPS.at(-1)[1]);
  }
  const hex = c => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');

  // Where a range sits on a shared scale, as fractions 0–1: {from, to}.
  function span(low, high, min, max) {
    const size = max - min || 1, clamp = v => Math.min(1, Math.max(0, v));
    return {from: clamp((low - min) / size), to: clamp((high - min) / size)};
  }

  // "Today", then weekday names, from "2026-11-06" relative to the place's own date.
  function dayLabel(date, today) {
    if (date === today) return 'Today';
    const [y, m, d] = String(date).split('-').map(Number);
    if (!y || !m || !d) return '';
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  }

  // "06:28" style local times as "6:28 AM".
  function clock(time) {
    const m = /T(\d{2}):(\d{2})/.exec(String(time));
    if (!m) return '';
    const h = Number(m[1]);
    return (h % 12 || 12) + ':' + m[2] + (h < 12 ? ' AM' : ' PM');
  }
  const minutesOf = time => { const m = /T(\d{2}):(\d{2})/.exec(String(time)); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

  // How far the sun is through today: 0 at sunrise, 1 at sunset; below 0 or above 1 at night.
  function sunProgress(now, sunrise, sunset) {
    const n = minutesOf(now), r = minutesOf(sunrise), s = minutesOf(sunset);
    if (n === null || r === null || s === null || s <= r) return null;
    return (n - r) / (s - r);
  }

  // Wind: km/h as mph or km/h, and where it blows from.
  function windSpeed(kmh, unit) {
    if (typeof kmh !== 'number' || !Number.isFinite(kmh)) return null;
    return units(unit) === 'celsius' ? {value: Math.round(kmh), unit: 'km/h'} : {value: Math.round(kmh * 0.621371), unit: 'mph'};
  }
  function compass(degreesFrom) {
    if (typeof degreesFrom !== 'number' || !Number.isFinite(degreesFrom)) return '';
    return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((degreesFrom % 360) + 360) % 360 / 45) % 8];
  }
  function uvLevel(uv) {
    if (typeof uv !== 'number' || !Number.isFinite(uv)) return '';
    return uv < 3 ? 'Low' : uv < 6 ? 'Moderate' : uv < 8 ? 'High' : uv < 11 ? 'Very high' : 'Extreme';
  }

  // A smooth line through points (Catmull-Rom as cubic Béziers), for the hourly curve.
  function smoothPath(points) {
    if (!points.length) return '';
    const f = n => Math.round(n * 10) / 10;
    let d = 'M' + f(points[0][0]) + ' ' + f(points[0][1]);
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i - 1] || points[i], p1 = points[i], p2 = points[i + 1], p3 = points[i + 2] || p2;
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += ' C' + [c1, c2, p2].map(p => f(p[0]) + ' ' + f(p[1])).join(' ');
    }
    return d;
  }

  globalThis.weatherModel = {layout, sky, tempColor, span, dayLabel, clock, sunProgress, windSpeed, compass, uvLevel, smoothPath,
    onColor, readable, cleanQuery, keyOf, units, temperature, degrees, hourLabel, precipText, ago, placeLines, status, icon,
    STALE_AFTER, OFFLINE_AFTER};
})();
