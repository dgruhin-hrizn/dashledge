import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';

const root = new URL('../widgets/packages/emby/', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');

test('Emby ships no personal hostname and names the server it reads', async () => {
  for (const file of ['widget.json', 'view/index.html', 'view/widget.js', 'collector/capture.mjs'])
    assert.doesNotMatch(await read(file), /goliath/i, file);
  const view = await read('view/widget.js');
  assert.match(view, /Dashledge\?\.displayName\(value\('info'\)\?\.ServerName\)/);
  assert.match(view, /'No active streams on '\+serverName\(\)/);
});

test('Emby renders natively with every px size scaled', async () => {
  assert.equal(JSON.parse(await read('widget.json')).view.viewport, 'native');
  const css = await read('view/style.css');
  const fixed = css.replace(/@media[^{]*\{/g, '').match(/(?<![\w.#-])(\d*\.?\d+)px\b/g) || [];
  assert.deepEqual(fixed.filter(v => !['0px', '1px'].includes(v) && !css.includes('calc(' + v + '*var(--px-scale,1))')), []);
  assert.ok(!(await readdir(new URL('view/', root))).includes('touch-map.js'));
});
