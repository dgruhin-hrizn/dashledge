import test from 'node:test';
import assert from 'node:assert/strict';
import {recordPackage, packageEntry, installed, widgetInfo, syncInstalled} from '../ui/widget-catalog.js';
import {initial} from '../ui/model.js';

const info = {apiVersion: 2, id: 'plugin.status', title: 'Status', tier: 'declarative', origin: 'installed',
  description: 'Server status', version: '1.0.0', iconData: 'data:image/png;base64,iVBOR', sources: {min: 1, max: 1},
  view: {entry: 'index.html'}, data: [{id: 's', path: 'x', every: 5}]};

test('a v2 package records only catalog fields in the layout', () => {
  assert.deepEqual(packageEntry({...info, actions: [{id: 'toggle'}], view: {entry: 'index.html', viewport: 'native'},
    sources: {min: 1, max: 1, auth: 'bearer', addressLabel: 'Hub URL', test: ['api/']}}), {apiVersion: 2, id: 'plugin.status',
    title: 'Status', tier: 'declarative', description: 'Server status', version: '1.0.0', iconData: 'data:image/png;base64,iVBOR',
    feed: 'plugin.status', sources: {min: 1, max: 1, addressLabel: 'Hub URL'}, viewport: 'native', actions: ['toggle']});
  assert.equal(packageEntry({...info, sources: {min: 1, max: 1, auth: 'basic', usernameLabel: 'Username'}}).sources.usernameLabel, 'Username',
    'the connection form asks for a username when the manifest labels one');
  const view = packageEntry({...info, sources: undefined});
  assert.equal(view.feed, undefined, 'a view-only package needs no connection');
});

test('installing records the package and updating keeps its placements', () => {
  const config = initial();
  assert.equal(recordPackage(config, info), true);
  assert.ok(installed(config, 'plugin.status'));
  assert.equal(widgetInfo(config, 'plugin.status').category, 'Installed packages');
  config.pages[0].slots[0] = {...config.pages[0].slots[0], kind: 'plugin.status', source: 'conn-1'};
  assert.equal(recordPackage(config, {...info, title: 'Status 2'}), false);
  assert.equal(config.plugins.length, 1);
  assert.equal(config.plugins[0].title, 'Status 2');
  assert.equal(config.pages[0].slots[0].source, 'conn-1', 'a v2 update keeps the chosen connection');
});

test('replacing a v1 package with v2 clears its JSON-feed connections', () => {
  const config = initial();
  config.plugins.push({apiVersion: 1, id: 'plugin.status', title: 'Old', feed: 'json', field: 'x', view: 'number', unit: '', accent: '#b8e883'});
  config.pages[0].slots[0] = {...config.pages[0].slots[0], kind: 'plugin.status', source: 'json-1'};
  recordPackage(config, info);
  assert.equal(config.pages[0].slots[0].source, '');
});

test('background updates and pulled versions reach the layout, and placements stay', () => {
  const config = initial();
  recordPackage(config, {...info, version: '1.0.0'});
  config.pages[0].slots[0] = {...config.pages[0].slots[0], kind: 'plugin.status', source: 'status-1'};
  assert.equal(syncInstalled(config, [{...info, version: '1.0.0'}]), 0, 'nothing changed on disk');
  assert.equal(syncInstalled(config, [{...info, version: '1.1.0'}, {...info, id: 'plugin.not-placed'}]), 1);
  assert.equal(config.plugins.find(p => p.id === 'plugin.status').version, '1.1.0');
  assert.equal(config.pages[0].slots[0].source, 'status-1', 'an update keeps the placement and its connection');
  syncInstalled(config, [{...info, version: '1.1.0', disabled: 'Leaks keys.'}]);
  assert.equal(config.plugins.find(p => p.id === 'plugin.status').disabled, 'Leaks keys.');
  syncInstalled(config, [{...info, version: '1.2.0'}]);
  assert.equal(config.plugins.find(p => p.id === 'plugin.status').disabled, undefined, 'an update lifts it');
  assert.ok(!config.plugins.some(p => p.id === 'plugin.not-placed'), 'packages the layout never recorded stay out');
});

test('connection types reach the catalog without their auth or Test routes', () => {
  const entry = packageEntry({...info, sources: {min: 1, max: 1, auth: 'none', types: [
    {id: 'sabnzbd', label: 'SABnzbd', auth: {query: 'apikey'}, test: ['api?mode=version'], credentialLabel: 'API key'},
    {id: 'nzbget', label: 'NZBGet', auth: 'basic', usernameLabel: 'Username'}]}});
  assert.deepEqual(entry.sources.types, [{id: 'sabnzbd', label: 'SABnzbd', credentialLabel: 'API key'}, {id: 'nzbget', label: 'NZBGet', usernameLabel: 'Username'}]);
});
