import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';

const root = new URL('../widgets/packages/ember/', import.meta.url);

test('Ember renders natively with no leftover host touch shim', async () => {
  const manifest = JSON.parse(await readFile(new URL('widget.json', root), 'utf8'));
  assert.equal(manifest.view.viewport, 'native');
  const files = await readdir(new URL('view/', root));
  assert.ok(!files.includes('visible-controls.js'));
  for (const file of files.filter(f => /\.(js|html|css)$/.test(f) && f !== 'marked.umd.js'))
    assert.doesNotMatch(await readFile(new URL('view/' + file, root), 'utf8'), /Zurface|Zeon|visible-controls/, file);
  // Rail icons are inline SVG symbols: a font would load cross-origin from the sandboxed frame.
  const html = await readFile(new URL('view/index.html', root), 'utf8');
  for (const [, symbol] of html.matchAll(/<use href="#([\w-]+)"/g)) assert.match(html, new RegExp('<symbol id="' + symbol + '"'), symbol);
  assert.ok(!files.some(f => /\.(ttf|otf|woff2?)$/.test(f)), 'no web font ships with the view');
});

test('Ember is called Ember', async () => {
  const manifest = JSON.parse(await readFile(new URL('widget.json', root), 'utf8'));
  assert.equal(manifest.title, 'Ember');
  assert.match(await readFile(new URL('view/index.html', root), 'utf8'), /<title>Ember<\/title>/);
});
