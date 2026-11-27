// Open-Meteo (no key, no account): place search and forecasts. Pure parsing lives here so
// tests can run it without the network; collect.mjs does the scheduling and I/O.

export const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
export const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
export const MAX_QUERY = 80;
const HOURS = 12;

// WMO weather interpretation codes, as Open-Meteo reports them, to an icon kind and a label.
export function describe(code) {
  if (code === null || code === undefined || !Number.isFinite(Number(code))) return null;
  switch (Number(code)) {
    case 0: return {kind: 'clear', label: 'Clear'};
    case 1: return {kind: 'partly', label: 'Mostly clear'};
    case 2: return {kind: 'partly', label: 'Partly cloudy'};
    case 3: return {kind: 'cloudy', label: 'Overcast'};
    case 45: return {kind: 'fog', label: 'Fog'};
    case 48: return {kind: 'fog', label: 'Freezing fog'};
    case 51: return {kind: 'drizzle', label: 'Light drizzle'};
    case 53: return {kind: 'drizzle', label: 'Drizzle'};
    case 55: return {kind: 'drizzle', label: 'Heavy drizzle'};
    case 56: case 57: return {kind: 'drizzle', label: 'Freezing drizzle'};
    case 61: return {kind: 'rain', label: 'Light rain'};
    case 63: return {kind: 'rain', label: 'Rain'};
    case 65: return {kind: 'rain', label: 'Heavy rain'};
    case 66: case 67: return {kind: 'rain', label: 'Freezing rain'};
    case 71: return {kind: 'snow', label: 'Light snow'};
    case 73: return {kind: 'snow', label: 'Snow'};
    case 75: return {kind: 'snow', label: 'Heavy snow'};
    case 77: return {kind: 'snow', label: 'Snow grains'};
    case 80: case 81: return {kind: 'rain', label: 'Rain showers'};
    case 82: return {kind: 'rain', label: 'Heavy showers'};
    case 85: case 86: return {kind: 'snow', label: 'Snow showers'};
    case 95: return {kind: 'storm', label: 'Thunderstorms'};
    case 96: case 99: return {kind: 'storm', label: 'Thunderstorms with hail'};
    default: return {kind: 'cloudy', label: 'Cloudy'};
  }
}

// What the user typed, tidied the same way the view tidies it. Empty or unusable is ''.
export function cleanQuery(value) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  if (!text || text.length > MAX_QUERY || /[\u0000-\u001f\u007f]/.test(text)) return '';
  return text;
}

const STATES = {al:'alabama',ak:'alaska',az:'arizona',ar:'arkansas',ca:'california',co:'colorado',ct:'connecticut',
  de:'delaware',dc:'district of columbia',fl:'florida',ga:'georgia',hi:'hawaii',id:'idaho',il:'illinois',in:'indiana',
  ia:'iowa',ks:'kansas',ky:'kentucky',la:'louisiana',me:'maine',md:'maryland',ma:'massachusetts',mi:'michigan',
  mn:'minnesota',ms:'mississippi',mo:'missouri',mt:'montana',ne:'nebraska',nv:'nevada',nh:'new hampshire',
  nj:'new jersey',nm:'new mexico',ny:'new york',nc:'north carolina',nd:'north dakota',oh:'ohio',ok:'oklahoma',
  or:'oregon',pa:'pennsylvania',ri:'rhode island',sc:'south carolina',sd:'south dakota',tn:'tennessee',tx:'texas',
  ut:'utah',vt:'vermont',va:'virginia',wa:'washington',wv:'west virginia',wi:'wisconsin',wy:'wyoming'};
const COUNTRY_NAMES = {usa: 'us', 'united states': 'us', america: 'us', uk: 'gb', 'united kingdom': 'gb', england: 'gb'};

// "Chicago", "Portland, OR", "Paris, France" or "41.88, -87.63". The place name goes to
// the geocoder; what follows a comma narrows its results.
export function parseQuery(query) {
  const text = cleanQuery(query);
  if (!text) return null;
  const coords = text.match(/^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (coords) {
    const latitude = Number(coords[1]), longitude = Number(coords[2]);
    if (Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) return {coordinates: {latitude, longitude}};
    return null;
  }
  const [name, ...rest] = text.split(',').map(part => part.trim());
  if (name.length < 2) return null;
  return {name, qualifiers: rest.filter(Boolean).map(q => q.toLowerCase())};
}

function matches(result, qualifier) {
  const fields = [result.admin1, result.admin2, result.admin3, result.country, result.country_code]
    .filter(v => typeof v === 'string').map(v => v.toLowerCase());
  const wanted = [qualifier, STATES[qualifier], COUNTRY_NAMES[qualifier]].filter(Boolean);
  return wanted.some(w => fields.some(f => f === w || (w.length >= 3 && f.startsWith(w))));
}

const placeOf = r => ({
  name: String(r.name), region: typeof r.admin1 === 'string' && r.admin1 !== r.name ? r.admin1 : '',
  country: typeof r.country === 'string' ? r.country : '', countryCode: typeof r.country_code === 'string' ? r.country_code : '',
  latitude: r.latitude, longitude: r.longitude, timezone: typeof r.timezone === 'string' ? r.timezone : '',
});

// The best geocoder result for a parsed query, or null when nothing fits. Open-Meteo
// orders results by relevance and population, so with no qualifiers the first wins.
export function pickPlace(json, parsed) {
  const results = Array.isArray(json?.results) ? json.results.filter(r =>
    r && typeof r.name === 'string' && Number.isFinite(r.latitude) && Number.isFinite(r.longitude)) : [];
  const qualifiers = parsed?.qualifiers || [];
  const hit = results.find(r => qualifiers.every(q => matches(r, q)));
  return hit ? placeOf(hit) : null;
}

export function geocodeUrl(name) {
  const url = new URL(GEOCODE_URL);
  url.search = new URLSearchParams({name, count: '10', language: 'en', format: 'json'}).toString();
  return url.toString();
}

export function forecastUrl({latitude, longitude}) {
  const url = new URL(FORECAST_URL);
  url.search = new URLSearchParams({
    latitude: String(latitude), longitude: String(longitude),
    current: 'temperature_2m,apparent_temperature,weather_code,is_day',
    hourly: 'temperature_2m,precipitation_probability,weather_code,is_day',
    daily: 'temperature_2m_max,temperature_2m_min',
    // Celsius with a decimal: the view converts, so changing units needs no new request.
    timezone: 'auto', forecast_days: '2',
  }).toString();
  return url.toString();
}

async function getJson(fetcher, url) {
  const response = await fetcher(url, {signal: AbortSignal.timeout(15000), headers: {accept: 'application/json'}});
  if (!response.ok) {
    let reason = '';
    try { reason = (await response.json())?.reason || ''; } catch {}
    throw new Error(reason ? String(reason).slice(0, 160) : 'Open-Meteo answered ' + response.status);
  }
  return response.json();
}

// The place a query names: {place} or {notFound: true}. Network trouble throws.
export async function geocode(query, fetcher = fetch) {
  const parsed = parseQuery(query);
  if (!parsed) return {notFound: true};
  if (parsed.coordinates) {
    const {latitude, longitude} = parsed.coordinates;
    return {place: {name: latitude.toFixed(2) + ', ' + longitude.toFixed(2), region: '', country: '', countryCode: '',
      latitude, longitude, timezone: '', coordinates: true}};
  }
  const place = pickPlace(await getJson(fetcher, geocodeUrl(parsed.name)), parsed);
  return place ? {place} : {notFound: true};
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Open-Meteo's forecast for the view: now, today's high and low, and the next 12 hours
// after the current one. Temperatures stay in °C with their decimal. Null when the
// response lacks the current reading.
export function parseForecast(json) {
  const c = json?.current, h = json?.hourly, d = json?.daily;
  const temp = num(c?.temperature_2m), now = describe(c?.weather_code);
  if (temp === null || !now) return null;
  const times = Array.isArray(h?.time) ? h.time : [];
  const hourOf = typeof c.time === 'string' ? c.time.slice(0, 13) : '';
  let start = times.findIndex(t => typeof t === 'string' && t.slice(0, 13) === hourOf);
  start = start < 0 ? 0 : start + 1;
  const hours = [];
  for (let i = start; i < times.length && hours.length < HOURS; i++) {
    const t = num(h.temperature_2m?.[i]);
    if (typeof times[i] !== 'string' || t === null) continue;
    hours.push({
      time: times[i], temp: t,
      // Null when Open-Meteo has no chance for that hour: unavailable, not 0%.
      precip: num(h.precipitation_probability?.[i]),
      kind: describe(h.weather_code?.[i])?.kind || 'cloudy',
      isDay: h.is_day?.[i] !== 0,
    });
  }
  return {
    time: typeof c.time === 'string' ? c.time : '',
    temp, feelsLike: num(c.apparent_temperature),
    kind: now.kind, label: now.label, isDay: c.is_day !== 0,
    high: num(d?.temperature_2m_max?.[0]), low: num(d?.temperature_2m_min?.[0]),
    timezone: typeof json.timezone === 'string' ? json.timezone : '',
    hours,
  };
}

export async function forecast(place, fetcher = fetch) {
  const weather = parseForecast(await getJson(fetcher, forecastUrl(place)));
  if (!weather) throw new Error('Open-Meteo sent an incomplete forecast');
  return weather;
}

// When to try again after `failures` failures in a row: 30 s, 1, 2, 5, then 10 minutes.
export function retryDelay(failures) {
  return [30, 60, 120, 300, 600][Math.min(Math.max(failures, 1), 5) - 1] * 1000;
}
