import {join} from 'node:path';
import {writeFile, rename} from 'node:fs/promises';
import {context, onCommand} from '../../_shared/context.mjs';
import {cleanQuery, forecast, geocode, retryDelay} from './weather.mjs';

// Weather needs no connection, so every Weather placement shares this one collector.
// Each view names its placement's location with the `watch` command and repeats it
// while it's on screen; locations nobody has asked about for a while are dropped.
// Entries are keyed by the query, never by placement, so two placements showing the
// same city share one forecast.
const REFRESH = 10 * 60 * 1000;
const NOT_FOUND_RETRY = 30 * 60 * 1000;
const FORGET_AFTER = 10 * 60 * 1000;
const MAX_PLACES = 32;
const TICK = 15 * 1000;

const places = new Map();
const file = join(context.directory, 'snapshot.js');
let writes = Promise.resolve();

function publish() {
  const out = {};
  for (const [key, e] of places) {
    out[key] = {query: e.query, state: e.state, place: e.place, weather: e.weather, at: e.at, error: e.error, failures: e.failures};
  }
  // The view loads this with a <script>, which an opaque-origin frame may do; fetch it may not.
  const data = 'window.weatherSample(' + JSON.stringify({at: Date.now(), places: out}) + ');';
  writes = writes.catch(() => {}).then(async () => { await writeFile(file + '.tmp', data); await rename(file + '.tmp', file); });
  return writes;
}

async function update(e) {
  e.busy = true;
  try {
    if (!e.place) {
      const found = await geocode(e.query);
      if (found.notFound) {
        Object.assign(e, {state: 'notfound', error: null, failures: 0, next: Date.now() + NOT_FOUND_RETRY});
        return;
      }
      e.place = found.place;
    }
    e.weather = await forecast(e.place);
    Object.assign(e, {state: 'ready', at: Date.now(), error: null, failures: 0, next: Date.now() + REFRESH});
  } catch (error) {
    // Keep the last good forecast; the view shows it as stale with the time it was read.
    e.failures += 1;
    Object.assign(e, {state: 'error', error: String(error?.message || error).slice(0, 160), next: Date.now() + retryDelay(e.failures)});
  } finally {
    e.busy = false;
    await publish().catch(() => {});
  }
}

function tick() {
  const now = Date.now();
  for (const [key, e] of places) if (now - e.heard > FORGET_AFTER && !e.busy) places.delete(key);
  for (const e of places.values()) if (!e.busy && e.next <= now) update(e);
  // Rewritten every tick so a view can tell a running collector from a stopped one.
  publish().catch(() => {});
}

onCommand('watch', args => {
  const query = cleanQuery(args?.query);
  if (!query) return;
  const key = query.toLowerCase();
  let e = places.get(key);
  if (!e) {
    if (places.size >= MAX_PLACES) {
      // Make room by forgetting the location heard from least recently.
      const oldest = [...places].filter(([, p]) => !p.busy).sort((a, b) => a[1].heard - b[1].heard)[0];
      if (!oldest) return;
      places.delete(oldest[0]);
    }
    e = {query, state: 'loading', place: null, weather: null, at: 0, error: null, failures: 0, next: 0, busy: false};
    places.set(key, e);
  }
  e.heard = Date.now();
  // Retry from the view: try now, and search again for a place that wasn't found.
  if (args?.refresh && !e.busy) {
    if (e.state === 'notfound') e.place = null;
    e.next = 0;
  }
  if (!e.busy && e.next <= Date.now()) update(e);
  else publish().catch(() => {});
});

publish();
setInterval(tick, TICK);
