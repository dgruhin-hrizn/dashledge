import test from 'node:test';
import assert from 'node:assert/strict';
import {recordPackage, packageEntry, installed, widgetInfo} from '../ui/widget-catalog.js';
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
