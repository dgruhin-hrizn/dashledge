import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {loadArtwork} from '../widgets/collectors/markets/artwork.mjs';

test('market logos request the ticker without Alpaca credentials and preserve the badge fallback', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'market-art-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  assert.equal(await loadArtwork('BRK.B', directory, (url, options) => {
    assert.equal(url.href, 'https://logoapi.sh/ticker/BRK.B.png?shape=square');
    assert.equal(options.headers, undefined);
    return new Response(png);
  }), true);
  assert.deepEqual(await readFile(join(directory, 'logos/BRK.B.png')), png);
  for (const response of [new Response('missing', {status:404}), new Response('html'), new Response(png, {headers:{'x-logo-fallback':'tile'}})]) {
    assert.equal(await loadArtwork('XYZ', directory, () => response), false);
  }
  await assert.rejects(readFile(join(directory, 'logos/XYZ.png')), {code:'ENOENT'});
});
