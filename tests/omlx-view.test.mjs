import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';

const root = new URL('../widgets/packages/omlx/', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');

test('oMLX sends model actions as the command its manifest declares', async () => {
  const manifest = JSON.parse(await read('widget.json'));
  assert.deepEqual(manifest.collector.commands, ['model']);
  const view = await read('view/widget.js');
  assert.match(view, /host\.command\("model", command\)/);
  assert.doesNotMatch(view, /Zurface|Zeon|storage\.set/);
  assert.ok(!(await readdir(new URL('view/', root))).includes('touch-map.js'));
});
