import test from 'node:test';
import assert from 'node:assert/strict';
import {isV2, packageFacts, packageTier, permissionSummary} from '../ui/package-manifest.js';

const base = {apiVersion: 2, id: 'plugin.home', title: 'Home', icon: 'icon.png', view: {entry: 'index.html'}};

test('tiers follow the most powerful declaration', () => {
  assert.equal(packageTier(base), 'view');
  assert.equal(packageTier({...base, data: [{id: 's', path: 'x', every: 5}]}), 'declarative');
  assert.equal(packageTier({...base, data: [{}], connector: {entry: 'c.js'}}), 'connector');
  assert.equal(packageTier({...base, collector: {entry: 'c.mjs', outputs: ['snapshot.js']}}), 'collector');
  assert.ok(isV2(base) && !isV2({apiVersion: 1}));
});

test('permission summary names every declared host and tier', () => {
  const lines = permissionSummary({...base, sources: {min: 1, max: 1}, actions: [{}],
    connector: {entry: 'c.js', hosts: ['https://api.example.com']}});
  assert.match(lines.join(' '), /one connection/);
  assert.match(lines.join(' '), /1 action/);
  assert.match(lines.join(' '), /sandbox/);
  assert.match(lines.join(' '), /https:\/\/api\.example\.com/);
  assert.deepEqual(permissionSummary(base), ['Shows its own view only. It can’t reach the network.']);
});

test('the install sheet lists the servers a typed widget connects to', () => {
  const lines = permissionSummary({...base, sources: {min: 1, max: 1, types: [{id: 'sabnzbd', label: 'SABnzbd'}, {id: 'nzbget', label: 'NZBGet'}, {id: 'qbittorrent', label: 'qBittorrent'}]}});
  assert.ok(lines.includes('Connects to SABnzbd, NZBGet or qBittorrent.'), lines.join(' | '));
});

test('the install sheet states version, license, home page and the app it needs', () => {
  assert.equal(packageFacts({version: '1.2.0', license: 'MIT', homepage: 'https://example.com/widget', minAppVersion: '0.9.0'}),
    'Version 1.2.0 · MIT license · example.com · Needs Dashledge 0.9.0 or later');
  assert.equal(packageFacts({}), '');
});
