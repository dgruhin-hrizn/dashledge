import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {cleanQuery, describe, forecastUrl, geocode, geocodeUrl, parseForecast, parseQuery, pickPlace, retryDelay} from '../widgets/packages/weather/collector/weather.mjs';

// The view's model is a classic script (views load it with <script>); run it the same way.
vm.runInThisContext(readFileSync(new URL('../widgets/packages/weather/view/model.js', import.meta.url), 'utf8'));
const M = globalThis.weatherModel;

const respond = body => async () => ({ok: true, status: 200, json: async () => body});

const chicago = {name: 'Chicago', latitude: 41.85, longitude: -87.65, country: 'United States', country_code: 'US', admin1: 'Illinois', timezone: 'America/Chicago'};
const portlandOR = {name: 'Portland', latitude: 45.52, longitude: -122.68, country: 'United States', country_code: 'US', admin1: 'Oregon'};
const portlandME = {name: 'Portland', latitude: 43.66, longitude: -70.26, country: 'United States', country_code: 'US', admin1: 'Maine'};
const parisFR = {name: 'Paris', latitude: 48.85, longitude: 2.35, country: 'France', country_code: 'FR', admin1: 'Île-de-France'};
const parisTX = {name: 'Paris', latitude: 33.66, longitude: -95.56, country: 'United States', country_code: 'US', admin1: 'Texas'};

test('WMO codes map to an icon kind and a label', () => {
  assert.deepEqual(describe(0), {kind: 'clear', label: 'Clear'});
  assert.equal(describe(2).kind, 'partly');
  assert.equal(describe(3).kind, 'cloudy');
  assert.equal(describe(48).kind, 'fog');
  assert.equal(describe(55).kind, 'drizzle');
  for (const code of [61, 63, 65, 66, 80, 82]) assert.equal(describe(code).kind, 'rain', String(code));
  for (const code of [71, 75, 77, 85, 86]) assert.equal(describe(code).kind, 'snow', String(code));
  for (const code of [95, 96, 99]) assert.equal(describe(code).kind, 'storm', String(code));
  assert.deepEqual(describe(42), {kind: 'cloudy', label: 'Cloudy'}, 'an unknown code still draws');
  assert.equal(describe(null), null);
  assert.equal(describe(undefined), null);
});

test('queries are tidied, capped and parsed into a name, qualifiers or coordinates', () => {
  assert.equal(cleanQuery('  New   York '), 'New York');
  assert.equal(cleanQuery('x'.repeat(81)), '');
  assert.equal(cleanQuery('Chi\u0000cago'), '');
  assert.equal(cleanQuery(42), '');
  assert.deepEqual(parseQuery('Portland, OR'), {name: 'Portland', qualifiers: ['or']});
  assert.deepEqual(parseQuery('41.88, -87.63'), {coordinates: {latitude: 41.88, longitude: -87.63}});
  assert.equal(parseQuery('95, 200'), null, 'coordinates out of range');
  assert.equal(parseQuery('a'), null, 'the geocoder needs two letters');
  assert.equal(parseQuery(''), null);
  // The view keys a placement's location exactly as the collector does.
  for (const q of ['  Paris,  France ', 'chicago', 'São Paulo']) assert.equal(M.cleanQuery(q), cleanQuery(q));
});

test('the first result wins unless a region or country narrows it', () => {
  const results = {results: [portlandOR, portlandME]};
  assert.equal(pickPlace(results, parseQuery('Portland')).region, 'Oregon');
  assert.equal(pickPlace(results, parseQuery('Portland, ME')).region, 'Maine');
  assert.equal(pickPlace(results, parseQuery('Portland, Maine')).region, 'Maine');
  assert.equal(pickPlace(results, parseQuery('Portland, Texas')), null);
  const paris = {results: [parisFR, parisTX]};
  assert.equal(pickPlace(paris, parseQuery('Paris, TX')).region, 'Texas');
  assert.equal(pickPlace(paris, parseQuery('Paris, USA')).region, 'Texas');
  assert.equal(pickPlace(paris, parseQuery('Paris, France')).countryCode, 'FR');
  assert.equal(pickPlace(paris, parseQuery('Paris, fr')).country, 'France');
  // Open-Meteo leaves `results` out when nothing matches.
  assert.equal(pickPlace({generationtime_ms: 0.4}, parseQuery('Nowhereville')), null);
  assert.equal(pickPlace({results: [{name: 'Broken'}]}, parseQuery('Broken')), null, 'results without coordinates are skipped');
  assert.deepEqual(pickPlace({results: [chicago]}, parseQuery('Chicago')), {
    name: 'Chicago', region: 'Illinois', country: 'United States', countryCode: 'US',
    latitude: 41.85, longitude: -87.65, timezone: 'America/Chicago'});
});

test('geocoding asks Open-Meteo by name and separates not found from failure', async () => {
  const asked = [];
  const found = await geocode('Chicago, IL', async url => { asked.push(url); return respond({results: [chicago]})(); });
  assert.equal(found.place.name, 'Chicago');
  assert.equal(asked.length, 1);
  const url = new URL(asked[0]);
  assert.equal(url.origin, 'https://geocoding-api.open-meteo.com');
  assert.equal(url.searchParams.get('name'), 'Chicago', 'the qualifier narrows results; it is not searched');
  assert.equal(geocodeUrl('São Paulo').includes('S%C3%A3o+Paulo'), true);

  assert.deepEqual(await geocode('Nowhereville', respond({})), {notFound: true});
  assert.deepEqual(await geocode('', respond({})), {notFound: true});
  let called = false;
  const coords = await geocode('41.88, -87.63', async () => { called = true; });
  assert.equal(called, false, 'coordinates need no lookup');
  assert.deepEqual([coords.place.latitude, coords.place.longitude, coords.place.name], [41.88, -87.63, '41.88, -87.63']);

  await assert.rejects(geocode('Chicago', async () => ({ok: false, status: 503, json: async () => ({reason: 'Busy'})})), /Busy/);
  await assert.rejects(geocode('Chicago', async () => { throw new Error('offline'); }), /offline/);
});

const sample = {
  timezone: 'America/Chicago', utc_offset_seconds: -21600,
  current: {time: '2026-11-06T14:15', temperature_2m: 8.6, apparent_temperature: 3.9, weather_code: 3, is_day: 1},
  hourly: {
    // Two days, as forecast_days=2 asks, so twelve hours fit late in the evening.
    time: Array.from({length: 48}, (_, i) => '2026-11-0' + (6 + Math.floor(i / 24)) + 'T' + String(i % 24).padStart(2, '0') + ':00'),
    temperature_2m: Array.from({length: 48}, (_, i) => 5 + i / 2),
    precipitation_probability: Array.from({length: 48}, (_, i) => (i === 16 ? null : i % 24 * 3)),
    weather_code: Array.from({length: 48}, (_, i) => (i === 15 ? 61 : 3)),
    is_day: Array.from({length: 48}, (_, i) => (i % 24 >= 7 && i % 24 < 17 ? 1 : 0)),
  },
  daily: {temperature_2m_max: [11.1], temperature_2m_min: [3.9]},
};

test('a forecast keeps °C decimals and the 12 hours after the current one', () => {
  const w = parseForecast(sample);
  assert.equal(w.temp, 8.6);
  assert.equal(w.feelsLike, 3.9);
  assert.deepEqual([w.kind, w.label, w.isDay, w.high, w.low], ['cloudy', 'Overcast', true, 11.1, 3.9]);
  assert.equal(w.hours.length, 12);
  assert.equal(w.hours[0].time, '2026-11-06T15:00', 'starts after the current hour');
  assert.equal(w.hours[0].kind, 'rain');
  assert.equal(w.hours[1].precip, null, 'a missing chance stays unknown, not 0%');
  assert.equal(w.hours[2].isDay, false);
  assert.equal(w.hours.at(-1).time, '2026-11-07T02:00', 'runs into tomorrow');
  assert.equal(parseForecast({current: {weather_code: 3}}), null, 'no reading, no forecast');
  assert.equal(parseForecast(null), null);
  const late = parseForecast({...sample, current: {...sample.current, time: '2026-11-07T20:40'}});
  assert.deepEqual(late.hours.map(h => h.time.slice(11, 13)), ['21', '22', '23'], 'only the hours the response holds');
  const missing = parseForecast({current: sample.current});
  assert.deepEqual([missing.high, missing.low, missing.hours], [null, null, []]);
});

test('the forecast request is Celsius with local times for the chosen place', () => {
  const url = new URL(forecastUrl({latitude: 41.85, longitude: -87.65}));
  assert.equal(url.origin + url.pathname, 'https://api.open-meteo.com/v1/forecast');
  assert.equal(url.searchParams.get('latitude'), '41.85');
  assert.equal(url.searchParams.get('timezone'), 'auto');
  assert.equal(url.searchParams.get('forecast_days'), '2');
  assert.equal(url.searchParams.get('temperature_unit'), null);
  assert.match(url.searchParams.get('hourly'), /precipitation_probability/);
});

test('failures back off to ten minutes', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(retryDelay), [30e3, 60e3, 120e3, 300e3, 600e3, 600e3]);
});

test('the view converts units, labels local hours and keeps unknowns visible', () => {
  assert.equal(M.temperature(8.6, 'fahrenheit'), 47);
  assert.equal(M.temperature(8.6, 'celsius'), 9);
  assert.equal(M.temperature(-0.4, 'celsius'), 0, 'no negative zero');
  assert.equal(M.temperature(null, 'celsius'), null);
  assert.equal(M.degrees(-17.8, 'fahrenheit'), '0°');
  assert.equal(M.degrees(undefined, 'celsius'), '–');
  assert.equal(M.units('kelvin'), 'fahrenheit');
  assert.deepEqual(['2026-11-06T00:00', '2026-11-06T09:00', '2026-11-06T12:00', '2026-11-06T23:00'].map(M.hourLabel),
    ['12 AM', '9 AM', '12 PM', '11 PM']);
  assert.equal(M.precipText(null), '–');
  assert.equal(M.precipText(35), '35%');
  assert.equal(M.precipText(0), '0%');
  assert.equal(M.icon('clear', false), 'clear-night');
  assert.equal(M.icon('rain', false), 'rain');
  assert.equal(M.icon('volcano', true), 'cloudy');
  assert.deepEqual(M.placeLines({name: 'Chicago', region: 'Illinois', country: 'United States'}),
    {name: 'Chicago', detail: 'Illinois · United States'});
});

test('the view tells empty, loading, not found, failure, fresh and stale apart', () => {
  const now = Date.parse('2026-11-06T20:00:00Z');
  const weather = parseForecast(sample);
  const kind = (query, entry, opts) => M.status(query, entry, now, opts);
  assert.equal(kind('', undefined).kind, 'empty');
  assert.equal(kind('', undefined).action, 'settings');
  assert.equal(kind('Chicago', undefined).kind, 'loading');
  assert.equal(kind('Chicago', {state: 'loading'}).kind, 'loading');
  const notFound = kind('Nowhereville', {state: 'notfound'});
  assert.deepEqual([notFound.kind, notFound.action], ['notfound', 'settings']);
  assert.match(notFound.title, /Nowhereville/);
  const failed = kind('Chicago', {state: 'error', error: 'offline', weather: null});
  assert.deepEqual([failed.kind, failed.action, failed.detail], ['failed', 'retry', 'offline']);
  const fresh = kind('Chicago', {state: 'ready', weather, at: now - 3 * 60000}, {snapshotAt: now});
  assert.deepEqual([fresh.kind, fresh.title], ['ready', 'Updated 3 min ago']);
  // A failed refresh keeps the last forecast; it only turns stale once it's old.
  assert.equal(kind('Chicago', {state: 'error', error: 'offline', weather, at: now - 12 * 60000}).kind, 'ready');
  const stale = kind('Chicago', {state: 'error', error: 'offline', weather, at: now - 45 * 60000});
  assert.deepEqual([stale.kind, stale.action], ['stale', 'retry']);
  assert.equal(kind('Chicago', {state: 'ready', weather, at: now - 60000}, {snapshotAt: now - 5 * 60000}).kind, 'stale',
    'a collector that stopped writing makes the forecast stale');
  assert.equal(kind('Chicago', undefined, {snapshotAt: now - 5 * 60000}).kind, 'failed');
  assert.equal(M.ago(now - 2 * 3600e3, now), 'Updated 2 hours ago');
  assert.equal(M.keyOf('  Portland,  OR '), 'portland, or');
});
