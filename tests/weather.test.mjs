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
  current: {time: '2026-11-06T14:15', temperature_2m: 8.6, apparent_temperature: 3.9, weather_code: 3, is_day: 1,
    relative_humidity_2m: 81, wind_speed_10m: 18.4, wind_direction_10m: 225, wind_gusts_10m: 31.7, surface_pressure: 1012.3, uv_index: 1.4},
  hourly: {
    // Two days of hours, so 24 hours after 2 PM run into tomorrow.
    time: Array.from({length: 48}, (_, i) => '2026-11-0' + (6 + Math.floor(i / 24)) + 'T' + String(i % 24).padStart(2, '0') + ':00'),
    temperature_2m: Array.from({length: 48}, (_, i) => 5 + i / 2),
    precipitation_probability: Array.from({length: 48}, (_, i) => (i === 16 ? null : i % 24 * 3)),
    weather_code: Array.from({length: 48}, (_, i) => (i === 15 ? 61 : 3)),
    is_day: Array.from({length: 48}, (_, i) => (i % 24 >= 7 && i % 24 < 17 ? 1 : 0)),
  },
  daily: {
    time: ['2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'],
    temperature_2m_max: [11.1, 12, 9.5, null, 7, 6, 8, 10], temperature_2m_min: [3.9, 4, 2.5, 1, 0, -1, 2, 3],
    weather_code: [3, 61, 0, 3, 71, 2, 1, 95], precipitation_probability_max: [20, 80, 5, 10, 60, 15, 0, 70],
    sunrise: ['2026-11-06T06:28', '2026-11-07T06:29'], sunset: ['2026-11-06T16:39', '2026-11-07T16:38'],
    uv_index_max: [2.1, 1.2, 3, 2, 1, 2, 2, 1],
  },
};

test('a forecast keeps °C decimals and the 24 hours after the current one', () => {
  const w = parseForecast(sample);
  assert.equal(w.temp, 8.6);
  assert.equal(w.feelsLike, 3.9);
  assert.deepEqual([w.kind, w.label, w.isDay, w.high, w.low], ['cloudy', 'Overcast', true, 11.1, 3.9]);
  assert.equal(w.hours.length, 24);
  assert.equal(w.hours[0].time, '2026-11-06T15:00', 'starts after the current hour');
  assert.equal(w.hours[0].kind, 'rain');
  assert.equal(w.hours[1].precip, null, 'a missing chance stays unknown, not 0%');
  assert.equal(w.hours[2].isDay, false);
  assert.equal(w.hours.at(-1).time, '2026-11-07T14:00', 'runs into tomorrow');
  assert.deepEqual([w.humidity, w.wind, w.gusts, w.windFrom, w.pressure, w.uv], [81, 18.4, 31.7, 225, 1012.3, 1.4]);
  assert.equal(parseForecast({current: {weather_code: 3}}), null, 'no reading, no forecast');
  assert.equal(parseForecast(null), null);
  const late = parseForecast({...sample, current: {...sample.current, time: '2026-11-07T20:40'}});
  assert.deepEqual(late.hours.map(h => h.time.slice(11, 13)), ['21', '22', '23'], 'only the hours the response holds');
  const missing = parseForecast({current: sample.current});
  assert.deepEqual([missing.high, missing.low, missing.hours, missing.days, missing.wind], [null, null, [], [], 18.4]);
});

test('the week holds seven complete days with their sun times', () => {
  const {days} = parseForecast(sample);
  assert.equal(days.length, 7, 'a day without a high is skipped; the eighth fills in');
  assert.deepEqual(days.map(d => d.date.slice(8)), ['06', '07', '08', '10', '11', '12', '13']);
  assert.deepEqual(days[1], {date: '2026-11-07', high: 12, low: 4, kind: 'rain', precip: 80,
    sunrise: '2026-11-07T06:29', sunset: '2026-11-07T16:38', uv: 1.2});
  assert.equal(days[2].sunrise, '', 'missing sun times stay empty');
});

test('the forecast request is Celsius with local times for the chosen place', () => {
  const url = new URL(forecastUrl({latitude: 41.85, longitude: -87.65}));
  assert.equal(url.origin + url.pathname, 'https://api.open-meteo.com/v1/forecast');
  assert.equal(url.searchParams.get('latitude'), '41.85');
  assert.equal(url.searchParams.get('timezone'), 'auto');
  assert.equal(url.searchParams.get('forecast_days'), '8');
  assert.match(url.searchParams.get('daily'), /sunrise/);
  assert.match(url.searchParams.get('current'), /wind_speed_10m/);
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

test('text on and in the highlight stays readable for any placement colour', () => {
  assert.equal(M.onColor('#f88d4f'), '#0b1019', 'default orange keeps dark text');
  assert.equal(M.onColor('#3a1f6b'), '#ffffff', 'dark purple gets white text');
  assert.equal(M.onColor('bad'), '#0b1019');
  assert.equal(M.readable('#f88d4f'), '#f88d4f', 'already readable as text');
  const lifted = M.readable('#3a1f6b');
  assert.notEqual(lifted, '#3a1f6b');
  assert.ok(parseInt(lifted.slice(5, 7), 16) > parseInt(lifted.slice(1, 3), 16), 'still purple');
});

test('each size gets its own composition, and Show overrides what fits', () => {
  assert.deepEqual(M.layout(1920, 540), {mode: 'full', panels: ['hourly', 'details', 'week']}, 'the whole Edge');
  assert.deepEqual(M.layout(1920, 540, 'now'), {mode: 'full', panels: ['details']});
  assert.deepEqual(M.layout(1280, 540), {mode: 'wide', panels: ['hourly', 'details']}, 'featured large');
  assert.deepEqual(M.layout(1280, 540, 'week'), {mode: 'wide', panels: ['week', 'details']});
  assert.deepEqual(M.layout(960, 540), {mode: 'wide', panels: ['hourly']}, 'two-up');
  assert.deepEqual(M.layout(640, 540), {mode: 'tall', panels: ['week']}, 'three-up');
  assert.deepEqual(M.layout(480, 540, 'hourly'), {mode: 'tall', panels: ['hourly']});
  assert.deepEqual(M.layout(640, 270), {mode: 'strip', panels: ['hourly']}, 'six-up');
  assert.deepEqual(M.layout(640, 270, 'week'), {mode: 'strip', panels: ['week']});
  assert.deepEqual(M.layout(480, 270), {mode: 'strip', panels: []}, 'too narrow for a second panel');
  assert.deepEqual(M.layout(280, 160), {mode: 'tiny', panels: []});
});

test('the sky follows the condition and the time of day', () => {
  assert.equal(M.sky('clear', true), 'clear-day');
  assert.equal(M.sky('clear', false), 'clear-night');
  assert.equal(M.sky('partly', false), 'partly-night');
  assert.equal(M.sky('drizzle', true), 'rain-day');
  assert.equal(M.sky('snow', false), 'snow-night');
  assert.equal(M.sky('storm', true), 'storm');
});

test('temperatures share one colour scale, and ranges sit on a shared axis', () => {
  assert.equal(M.tempColor(-30), '#9278ff', 'colder than the scale: its coldest colour');
  assert.equal(M.tempColor(40), '#ff5454');
  assert.notEqual(M.tempColor(0), M.tempColor(25));
  assert.equal(M.tempColor(null), '#9aa4b4');
  assert.deepEqual(M.span(5, 15, 0, 20), {from: .25, to: .75});
  assert.deepEqual(M.span(-5, 30, 0, 20), {from: 0, to: 1}, 'clamped');
});

test('days, clock times, sun, wind and UV read the way people say them', () => {
  assert.equal(M.dayLabel('2026-11-26', '2026-11-26'), 'Today');
  assert.equal(M.dayLabel('2026-11-27', '2026-11-26'), 'Fri');
  assert.equal(M.clock('2026-11-26T06:28'), '6:28 AM');
  assert.equal(M.clock('2026-11-26T16:39'), '4:39 PM');
  assert.equal(M.sunProgress('2026-11-26T11:30', '2026-11-26T06:30', '2026-11-26T16:30'), .5);
  assert.ok(M.sunProgress('2026-11-26T21:00', '2026-11-26T06:30', '2026-11-26T16:30') > 1, 'after sunset');
  assert.deepEqual(M.windSpeed(30, 'fahrenheit'), {value: 19, unit: 'mph'});
  assert.deepEqual(M.windSpeed(30, 'celsius'), {value: 30, unit: 'km/h'});
  assert.equal(M.windSpeed(null, 'celsius'), null);
  assert.deepEqual([0, 44, 225, 359, -45].map(M.compass), ['N', 'NE', 'SW', 'N', 'NW']);
  assert.deepEqual([1, 4, 7, 9, 12].map(M.uvLevel), ['Low', 'Moderate', 'High', 'Very high', 'Extreme']);
  assert.match(M.smoothPath([[0, 10], [10, 0], [20, 10]]), /^M0 10 C.* C.* 20 10$/);
  assert.equal(M.smoothPath([]), '');
});
