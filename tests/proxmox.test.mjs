import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read = path => readFile(new URL('../widgets/packages/proxmox/' + path, import.meta.url), 'utf8');

test('Proxmox renders natively with scaled px sizes and scaled node pages', async () => {
  assert.equal(JSON.parse(await read('widget.json')).view.viewport, 'native');
  const css = await read('view/style.css');
  const fixed = css.replace(/@media[^{]*\{/g, '').match(/(?<![\w.#-])(\d*\.?\d+)px\b/g) || [];
  assert.deepEqual(fixed.filter(v => !['0px', '1px'].includes(v) && !css.includes('calc(' + v + '*var(--px-scale,1))')), []);
  assert.match(await read('view/widget.js'), /clientWidth\/\(275\*scale\)/);
});

test('the cluster title uses the connection name, the cluster’s own name, or the host', async () => {
  const view = await read('view/widget.js');
  assert.match(view, /Dashledge\?\.displayName\(data\?\.name\)/);
  assert.doesNotMatch(await read('collector/api.mjs'), /"Proxmox cluster"/, 'no made-up name competes with the host');
});
