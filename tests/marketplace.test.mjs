import test from 'node:test';
import assert from 'node:assert/strict';
import {marketplaceGroups, pluginStatus, pluginAction} from '../ui/marketplace.js';

const plugin = (over = {}) => ({id: 'plugin.alice.queue', title: 'Queue', publisher: 'alice', summary: 'Downloads now.',
  category: 'Music & media', available: '1.1.0', versions: [{version: '1.1.0', published: 0}], ...over});

test('plugins group by category, search across text, and updates come first', () => {
  const view = {plugins: [
    plugin(),
    plugin({id: 'plugin.bob.docker', title: 'Docker hosts', publisher: 'bob', category: 'Servers & storage', installed: '1.0.0', origin: 'marketplace', update: '1.1.0', updateAdds: []}),
    plugin({id: 'plugin.bob.misc', title: 'Misc', category: undefined}),
  ]};
  const {attention, groups} = marketplaceGroups(view);
  assert.deepEqual(attention.map(p => p.id), ['plugin.bob.docker']);
  assert.deepEqual(groups.map(([name]) => name), ['Music & media', 'Servers & storage', 'Other'], 'Other sorts last');
  assert.deepEqual(marketplaceGroups(view, 'BOB docker').groups.flatMap(([, list]) => list.map(p => p.id)), ['plugin.bob.docker']);
  assert.deepEqual(marketplaceGroups(view, 'nothing here').groups, []);
});

test('each plugin shows where it stands and offers the right action', () => {
  assert.equal(pluginStatus(plugin()), null);
  assert.deepEqual(pluginAction(plugin()), {label: 'Install', version: '1.1.0'});

  const quiet = plugin({installed: '1.0.0', origin: 'marketplace', update: '1.1.0', updateAdds: []});
  assert.equal(pluginStatus(quiet).label, 'Update available');
  assert.deepEqual(pluginAction(quiet), {label: 'Update', version: '1.1.0'});

  const asks = {...quiet, updateAdds: [{kind: 'host', value: 'https://api.example.com'}]};
  assert.equal(pluginStatus(asks).label, 'Update needs approval');
  assert.equal(pluginAction(asks).label, 'Review update');

  const pulled = plugin({installed: '1.0.0', origin: 'marketplace', pulled: 'Leaks keys.'});
  assert.equal(pluginStatus(pulled).tone, 'danger');
  assert.match(pluginStatus(pulled).text, /Leaks keys/);
  assert.deepEqual(pluginAction(pulled), {label: 'Install 1.1.0', version: '1.1.0'});

  const fromFile = plugin({installed: '1.1.0', origin: 'installed'});
  assert.equal(pluginStatus(fromFile).label, 'Unverified');
  assert.equal(pluginAction(fromFile).label, 'Replace with Marketplace version');

  const unpacked = plugin({installed: '1.1.0', origin: 'unpacked'});
  assert.equal(pluginStatus(unpacked).label, 'Unpacked');
  assert.equal(pluginAction(unpacked), null, 'an author’s folder is never replaced from here');

  const newer = plugin({available: null});
  assert.equal(pluginStatus(newer).label, 'Needs a newer Dashledge');
  assert.equal(pluginAction(newer), null);
  assert.equal(pluginAction(plugin({installed: '1.1.0', origin: 'marketplace'})), null, 'up to date');
});
