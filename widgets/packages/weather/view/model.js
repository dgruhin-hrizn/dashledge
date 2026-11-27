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

  globalThis.weatherModel = {cleanQuery, keyOf, units, temperature, degrees, hourLabel, precipText, ago, placeLines, status, icon,
    STALE_AFTER, OFFLINE_AFTER};
})();
