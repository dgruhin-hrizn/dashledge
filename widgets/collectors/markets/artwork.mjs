import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const maxBytes = 2_000_000;

export async function loadArtwork(symbol, directory, fetchImage = fetch) {
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol)) return false;
  const url = new URL('/ticker/' + symbol + '.png', 'https://logoapi.sh');
  url.searchParams.set('shape', 'square');
  const response = await fetchImage(url, {signal: AbortSignal.timeout(10000)});
  if (!response.ok || response.headers.get('x-logo-fallback') === 'tile' ||
      Number(response.headers.get('content-length')) > maxBytes || !response.body) {
    await response.body?.cancel();
    return false;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maxBytes) return false;
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (!bytes.subarray(0, 8).equals(pngSignature)) return false;
  const folder = join(directory, 'logos');
  await mkdir(folder, {recursive: true});
  await writeFile(join(folder, symbol + '.png'), bytes);
  return true;
}
