// Register the bundled packages the way the app does, reading widget.json from disk.
import {readdir, readFile} from 'node:fs/promises';
import {registerPackages} from '../../ui/packages.js';

const root = new URL('../../widgets/packages/', import.meta.url);
const list = [];
for (const entry of await readdir(root, {withFileTypes: true})) {
  if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
  const manifest = JSON.parse(await readFile(new URL(entry.name + '/widget.json', root), 'utf8'));
  list.push({...manifest, origin: 'bundled', tier: 'collector'});
}
registerPackages(list);
export const bundledPackages = list;
