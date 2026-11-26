// Weather (example) connector. It runs sandboxed: it can reach only the hosts
// widget.json declares, and it has no files, processes or modules.
// Change these to your location.
const PLACE = {name: 'Cupertino', latitude: 37.323, longitude: -122.032};
const EVERY = 10 * 60 * 1000;

const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + PLACE.latitude + '&longitude=' + PLACE.longitude +
  '&current=temperature_2m,weather_code,wind_speed_10m&hourly=temperature_2m&forecast_days=1&timezone=auto';

async function refresh() {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Open-Meteo returned HTTP ' + response.status);
    const body = await response.json();
    const reading = {
      place: PLACE.name,
      temperature: body.current.temperature_2m,
      unit: body.current_units?.temperature_2m || '°C',
      code: body.current.weather_code,
      wind: body.current.wind_speed_10m,
      windUnit: body.current_units?.wind_speed_10m || 'km/h',
      hourly: body.hourly.temperature_2m,
      at: Date.now(),
    };
    // Storage keeps the last good reading, so the view has something after a restart.
    dashledge.storage.set('last', reading);
    dashledge.emit({status: 'ok', reading});
  } catch (error) {
    dashledge.emit({status: 'error', error: String(error.message || error), reading: dashledge.storage.get('last')});
  }
}

refresh();
setInterval(refresh, EVERY);
