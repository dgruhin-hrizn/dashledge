// Weather (example) view. It runs in a sandboxed frame; data arrives from the
// connector through window.Dashledge.onData.
const codes = {0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Fog', 51: 'Drizzle',
  53: 'Drizzle', 55: 'Drizzle', 61: 'Rain', 63: 'Rain', 65: 'Heavy rain', 71: 'Snow', 73: 'Snow', 75: 'Heavy snow',
  80: 'Showers', 81: 'Showers', 82: 'Heavy showers', 95: 'Thunderstorm', 96: 'Thunderstorm', 99: 'Thunderstorm'};
const $ = id => document.getElementById(id);

function chart(values) {
  const svg = $('chart');
  if (!values?.length) { svg.replaceChildren(); return; }
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const points = values.map((v, i) => (i / (values.length - 1) * 240).toFixed(1) + ',' + (76 - (v - min) / span * 72).toFixed(1));
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M' + points.join(' L'));
  svg.replaceChildren(path);
}

window.Dashledge.onData(({data, error}) => {
  const reading = data?.reading;
  if (error) $('detail').textContent = 'Connector stopped: ' + error;
  if (!reading) {
    if (data?.status === 'error') $('detail').textContent = 'Weather unavailable · ' + data.error;
    return;
  }
  $('place').textContent = reading.place;
  $('temperature').textContent = Math.round(reading.temperature);
  $('unit').textContent = reading.unit;
  const age = Math.round((Date.now() - reading.at) / 60000);
  $('detail').textContent = (codes[reading.code] || 'Weather') + ' · Wind ' + Math.round(reading.wind) + ' ' + reading.windUnit +
    (data.status === 'error' ? ' · Last reading ' + age + ' min ago' : '');
  chart(reading.hourly);
});
