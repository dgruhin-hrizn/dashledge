import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';

const root = new URL('../widgets/packages/comfy/', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');

test('ComfyUI renders natively with every px size scaled', async () => {
  assert.equal(JSON.parse(await read('widget.json')).view.viewport, 'native');
  const css = await read('view/style.css');
  const fixed = css.replace(/@media[^{]*\{/g, '').match(/(?<![\w.#-])(\d*\.?\d+)px\b/g) || [];
  assert.deepEqual(fixed.filter(v => !['0px', '1px'].includes(v) && !css.includes('calc(' + v + '*var(--px-scale,1))')), []);
  assert.ok(!(await readdir(new URL('view/', root))).includes('touch-map.js'));
});
