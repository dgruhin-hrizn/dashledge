import './helpers/bundled-packages.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {migratePlanSettings, titles, originalKinds} from '../ui/model.js';
import {installed, widgetInfo} from '../ui/widget-catalog.js';
import {packageInfo} from '../ui/packages.js';
import {settingValues} from '../ui/package-settings.js';

// A layout saved before AI Plan Monitor became a package: choices on the slot as
// planDisplay, and Widget Studio defaults for slots without their own as planDefaults.
const saved = () => ({
  version: 1, originalDashboards: true,
  pages: [
    {id: 'p1', name: 'AI', preset: 'Four', slots: [
      // Its own overview list, with a name for one account.
      {id: 's1', kind: 'plans', source: '', volume: '', planDisplay: {mode: 'overview', ids: ['claude:work', 'codex:local'], pin: '', aliases: {'claude:work': 'Work'}}},
      // No choices of its own: it followed the Widget Studio defaults.
      {id: 's2', kind: 'plans', source: '', volume: ''},
      // Every account, including ones found later.
      {id: 's3', kind: 'plans', source: '', volume: '', planDisplay: {mode: 'overview', ids: null, pin: 'claude:main', aliases: {}}},
      // One account full size, renamed.
      {id: 's4', kind: 'plans', source: '', volume: '', planDisplay: {mode: 'account', ids: null, pin: 'codex:personal', aliases: {'codex:personal': ' Side project ', 'bad key': 'x'}}},
    ]},
    {id: 'p2', name: 'Mac', preset: 'One', slots: [{id: 's5', kind: 'cpu', source: '', volume: ''}]},
  ],
  sources: [], plugins: [],
  planDefaults: {mode: 'account', ids: null, pin: 'claude:main', aliases: {'claude:main': 'Home'}},
});

test('saved plan choices become the package settings of each placement', () => {
  const config = saved();
  assert.equal(migratePlanSettings(config), true);
  const slots = Object.fromEntries(config.pages[0].slots.map(s => [s.id, s]));
  assert.deepEqual(slots.s1.packageSettings, {accounts: ['claude:work', 'codex:local'], names: {'claude:work': 'Work'}});
  assert.deepEqual(slots.s2.packageSettings, {accounts: ['claude:main'], names: {'claude:main': 'Home'}}, 'inherits the old defaults');
  assert.deepEqual(slots.s3.packageSettings, {accounts: ['*'], names: {}});
  assert.deepEqual(slots.s4.packageSettings, {accounts: ['codex:personal'], names: {'codex:personal': 'Side project'}});
  for (const slot of config.pages.flatMap(p => p.slots)) assert.equal('planDisplay' in slot, false);
  assert.equal('planDefaults' in config, false);
  assert.equal('packageSettings' in config.pages[1].slots[0], false, 'other widgets are untouched');
});

test('the migration runs once and leaves later edits alone', () => {
  const config = saved();
  migratePlanSettings(config);
  const once = JSON.stringify(config);
  assert.equal(migratePlanSettings(config), false);
  assert.equal(JSON.stringify(config), once);
  config.pages[0].slots[0].packageSettings = {accounts: ['codex:local'], names: {}};
  assert.equal(migratePlanSettings(config), false);
  assert.deepEqual(config.pages[0].slots[0].packageSettings.accounts, ['codex:local']);
});

test('migrated settings resolve unchanged against the package schema', () => {
  const config = saved();
  migratePlanSettings(config);
  const schema = packageInfo.get('plans').settings.map(s => s.type === 'names' ? {...s, default: {}} : s);
  for (const slot of config.pages[0].slots) assert.deepEqual(settingValues(schema, slot.packageSettings), slot.packageSettings, slot.id);
});

test('AI Plan Monitor is a bundled package with the same kind and title', () => {
  const config = saved();
  assert.ok(packageInfo.has('plans'));
  assert.ok(originalKinds.includes('plans'));
  assert.equal(titles.plans, 'AI Plan Monitor');
  assert.ok(installed(config, 'plans'));
  assert.equal(widgetInfo(config, 'plans').icon, '/widget-icon/plans');
  assert.equal(widgetInfo(config, 'plans').category, 'AI & development');
});
