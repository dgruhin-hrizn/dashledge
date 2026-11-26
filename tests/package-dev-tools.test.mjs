import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const types = await read('widgets/example/dashledge.d.ts');
const section = (start, end) => types.slice(types.indexOf(start), end ? types.indexOf(end) : undefined);

test('the view declarations cover every member of the package SDK', async () => {
  const sdk = await read('ui/package-sdk.js');
  const literal = sdk.match(/const api = \{([\s\S]*?)\n {2}\};/)[1];
  const members = new Set([...literal.matchAll(/^ {4}(\w+)\(/gm), ...sdk.matchAll(/\bapi\.(\w+) = /g)].map(m => m[1]));
  assert.ok(members.size >= 8, [...members].join());
  const api = section('interface API {', '// ----------------------------------------------------------- connectors');
  for (const member of members) assert.match(api, new RegExp('\\n {4}' + member + '[(:<]'), member);
});

test('the connector declarations cover every global the prelude defines', async () => {
  const prelude = await read('src-tauri/src/connector_prelude.js');
  const globals = new Set([...prelude.matchAll(/globalThis\.(\w+) =(?!=)/g)].map(m => m[1]).filter(name => !name.startsWith('__')));
  globals.add('dashledge');
  const declared = section('interface Globals {');
  for (const name of globals) assert.match(declared, new RegExp('\\n {4}' + name + '[(:]'), name);
});

test('an unpacked package is marked with its folder in the catalog', async () => {
  globalThis.localStorage ??= {getItem: () => null, setItem() {}};
  const {packageEntry} = await import('../ui/widget-catalog.js');
  const info = {id: 'plugin.dev', title: 'Dev', tier: 'connector', origin: 'unpacked', path: '/Users/me/dev-widget'};
  assert.deepEqual([packageEntry(info).unpacked, packageEntry(info).path], [true, '/Users/me/dev-widget']);
  const installed = packageEntry({...info, origin: 'installed', path: undefined});
  assert.equal(installed.unpacked, undefined);
  assert.equal(installed.path, undefined);
});
