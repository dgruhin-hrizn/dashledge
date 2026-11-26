// Bundled widget packages, read from their widget.json manifests through
// list_packages. Registering one fills the title, catalog and connection tables the
// rest of the UI reads, so widgets/packages/ is the single source of these details.
import {titles, originalKinds} from './model.js';
import {registerCatalog} from './widget-catalog.js';
import {invoke} from './common.js';

export const packageInfo = new Map();

export function registerPackages(list) {
  for (const info of list) {
    if (info.origin !== 'bundled' || !info.collector) continue;
    packageInfo.set(info.id, info);
    titles[info.id] = info.title;
    if (!originalKinds.includes(info.id)) originalKinds.push(info.id);
    registerCatalog(info);
  }
}

export async function loadPackages() {
  try { registerPackages(await invoke('list_packages')); } catch {}
}

// Should this widget render at the display's real size when it fills the page?
export const nativeViewport = kind => packageInfo.get(kind)?.view?.viewport === 'native';
// How many connections a bundled widget takes, from its manifest.
export const sourceLimit = kind => packageInfo.get(kind)?.sources?.max ?? 0;
