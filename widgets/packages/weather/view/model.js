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

  globalThis.weatherModel = {onColor, readable, cleanQuery, keyOf, units, temperature, degrees, hourLabel, precipText, ago, placeLines, status, icon,
    STALE_AFTER, OFFLINE_AFTER};
})();
