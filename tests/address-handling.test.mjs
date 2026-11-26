import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {route} from '../widgets/packages/omlx/collector/address.mjs';
import {modelControls} from '../widgets/packages/omlx/collector/model-control.mjs';
import {endpoint, apiURL} from '../widgets/packages/proxmox/collector/api.mjs';

// Dashledge hands collectors the base it resolved for Test (connections::resolve):
// the saved address with its path kept as a directory.
test('oMLX requests stay under a reverse-proxy prefix', async () => {
  const server = {base: 'https://proxy.local/omlx/', name: 'Studio', key: ''};
  assert.equal(route(server, '/api/status'), 'https://proxy.local/omlx/api/status');
  assert.equal(route(server, '/v1/models/status'), 'https://proxy.local/omlx/v1/models/status');
  assert.equal(route({base: 'http://localhost:8000/'}, '/api/status'), 'http://localhost:8000/api/status');
});

test('oMLX model actions go to the prefixed server', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dashledge-address-'));
  try {
    const address = 'https://proxy.local/omlx/', viewer = 'omlx-dashboard@fixture';
    const tap = {id: 'a'.repeat(32), at: Date.now(), action: 'load', address, model: 'qwen'};
    const calls = [];
    const controls = await modelControls({state: join(dir, 'claims.json'),
      preferences: () => ({widgetStorage: {[viewer]: {'omlx.modelAction': JSON.stringify(tap)}}}),
      fetchApi: async url => { calls.push(url); return {status: 202, ok: true}; }});
    await controls.consume([{base: address}], [{address, canControl: true, models: [{id: 'qwen', loaded: false, controllable: true}]}]);
    assert.deepEqual(calls, ['https://proxy.local/omlx/admin/api/models/qwen/load']);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('Proxmox API routes join beneath the cluster base', () => {
  assert.equal(apiURL(endpoint('https://pve.local:8006'), '/cluster/resources').href, 'https://pve.local:8006/api2/json/cluster/resources');
  assert.equal(apiURL(endpoint('https://proxy.local/pve/'), '/cluster/status').href, 'https://proxy.local/pve/api2/json/cluster/status');
  assert.equal(apiURL(endpoint('https://proxy.local/pve'), '/nodes').href, 'https://proxy.local/pve/api2/json/nodes');
  for (const bad of ['pve.local', 'ftp://pve.local', 'https://u:p@pve.local', 'https://pve.local/?x=1']) assert.throws(() => endpoint(bad), bad);
});

test('oMLX and Proxmox resolve addresses with their path, like Test', async () => {
  for (const kind of ['omlx', 'proxmox']) {
    const manifest = JSON.parse(await readFile(new URL(`../widgets/packages/${kind}/widget.json`, import.meta.url), 'utf8'));
    assert.equal(manifest.sources.address, 'path', kind);
  }
});
