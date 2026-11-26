import './helpers/bundled-packages.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {displayName, connectionLabel, hostOf} from '../ui/display-name.js';
import {widgetSources} from '../ui/original-widgets.js';

test('a typed name wins, then the server’s own name, then the host', () => {
  const automatic = {name: '', address: 'http://tower.local:8043/api/v1/'};
  assert.equal(displayName({...automatic, name: 'Basement'}, 'TOWER'), 'Basement');
  assert.equal(displayName(automatic, 'TOWER'), 'TOWER');
  assert.equal(displayName(automatic, '   '), 'tower.local');
  assert.equal(displayName({name: '  ', address: 'not a url'}), '');
  assert.equal(connectionLabel(automatic), 'tower.local');
  assert.equal(hostOf('https://pve.local:8006'), 'pve.local');
});

test('collectors get a usable label for automatic connections', () => {
  const sources = [
    {id: 'o1', kind: 'omlx', name: '', address: 'http://studio.local:8000'},
    {id: 'o2', kind: 'omlx', name: 'Laptop', address: 'http://laptop.local:8000'},
  ];
  assert.deepEqual(widgetSources('omlx', 'o1', sources).map(s => s.name), ['studio.local', 'Laptop']);
});
