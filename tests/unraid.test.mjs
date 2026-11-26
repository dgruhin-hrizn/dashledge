import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';

const root = new URL('../widgets/packages/unraid/', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');

test('Unraid ships no personal hostname and names the server from its data', async () => {
  const files = ['widget.json', 'view/index.html', 'view/widget.js', 'view/assignments.js', 'view/catalog-icons.js',
    'collector/capture.mjs', 'collector/telemetry.mjs'];
  for (const file of files) assert.doesNotMatch(await read(file), /goliath/i, file);
  const view = await read('view/widget.js');
  assert.match(view, /Dashledge\?\.displayName\(s\.hostname\)/);
  assert.match(view, /s\?\.kind==='unraid'/, 'the view accepts the collector’s snapshot kind');
  assert.match(await read('collector/capture.mjs'), /await run\('unraid'\)/);
});

test('Unraid renders natively with px sizes scaled to their reference size', async () => {
  const manifest = JSON.parse(await read('widget.json'));
  assert.equal(manifest.view.viewport, 'native');
  const css = await read('view/style.css');
  const fixed = css.replace(/@media[^{]*\{/g, '').match(/(?<![\w.#-])(\d*\.?\d+)px\b/g) || [];
  const unscaled = fixed.filter(v => !['0px', '1px'].includes(v) && !css.includes('calc(' + v + '*var(--px-scale,1))'));
  assert.deepEqual(unscaled, []);
  assert.ok(!(await readdir(new URL('view/', root))).includes('touch-map.js'));
});
