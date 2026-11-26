import './helpers/bundled-packages.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {addOriginalPages, titles} from '../ui/model.js';
import {installed, widgetInfo, connectionsFor, defaultSource} from '../ui/widget-catalog.js';
import {widgetSources} from '../ui/original-widgets.js';

// A layout saved by Dashledge 0.6.5, before bundled widgets were packages.
const saved = () => ({
  version: 1, originalDashboards: true,
  pages: [
    {id: 'p1', name: 'Servers', preset: 'Three', slots: [
      {id: 's1', kind: 'unraid', source: 'u1', volume: ''},
      {id: 's2', kind: 'proxmox', source: 'x1', volume: ''},
      {id: 's3', kind: 'emby', source: 'e1', volume: ''}]},
    {id: 'p2', name: 'Studio', preset: 'Featured', slots: [
      {id: 's4', kind: 'comfy', source: 'c1', volume: ''},
      {id: 's5', kind: 'omlx', source: 'o2', volume: ''},
      {id: 's6', kind: 'ember', source: '', volume: ''}]},
  ],
  sources: [
    {id: 'u1', kind: 'unraid', name: 'Tower', address: 'http://tower.local:8043/api/v1/'},
    {id: 'x1', kind: 'proxmox', name: 'Cluster', address: 'https://pve.local:8006', gpuGuests: {101: 'root@worker.local'}},
    {id: 'e1', kind: 'emby', name: 'Media', address: 'http://media.local:8096/emby/'},
    {id: 'c1', kind: 'comfy', name: 'Worker', address: 'http://worker.local:8188'},
    {id: 'c2', kind: 'comfy', name: 'Worker 2', address: 'http://worker2.local:8188'},
    {id: 'o1', kind: 'omlx', name: 'Studio Mac', address: 'http://localhost:8000'},
    {id: 'o2', kind: 'omlx', name: 'Laptop', address: 'http://laptop.local:8000'},
  ],
  widgetDefaults: {omlx: 'o2'},
  plugins: [],
});

test('every 0.6.5 placement still resolves to a bundled widget', () => {
  const config = saved();
  for (const page of config.pages) for (const slot of page.slots) {
    assert.ok(installed(config, slot.kind), slot.kind + ' is installed');
    const info = widgetInfo(config, slot.kind);
    assert.equal(info.title, titles[slot.kind]);
    assert.equal(info.icon, '/widget-icon/' + slot.kind);
    assert.ok(info.version, slot.kind + ' keeps a version');
  }
});

test('saved connections and defaults still apply', () => {
  const config = saved();
  assert.deepEqual(connectionsFor(config, 'omlx').map(s => s.id), ['o1', 'o2']);
  assert.equal(defaultSource(config, 'omlx'), 'o2');
  assert.deepEqual(widgetSources('comfy', 'c1', config.sources).map(s => s.name), ['Worker', 'Worker 2']);
  assert.deepEqual(widgetSources('comfy', 'c1', config.sources)[0].gpuGuests, {worker: 'root@worker.local'});
  assert.equal(widgetSources('omlx', 'o2', config.sources)[0].name, 'Laptop');
  assert.equal(widgetSources('unraid', 'u1', config.sources).length, 1);
  assert.deepEqual(widgetSources('ember', '', config.sources), []);
});

test('an upgraded layout gets no duplicate dashboard pages', () => {
  const config = saved();
  assert.equal(addOriginalPages(config), false);
  assert.equal(config.pages.length, 2);
});
