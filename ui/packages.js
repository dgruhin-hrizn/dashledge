// Bundled widget packages, read from their widget.json manifests through
// list_packages. Registering one fills the title, catalog and connection tables the
// rest of the UI reads, so widgets/packages/ is the single source of these details.
import {titles, originalKinds, pagelessKinds} from './model.js';
import {registerCatalog} from './widget-catalog.js';
import {invoke} from './common.js';

export const packageInfo = new Map();
// Installed and unpacked packages as Rust lists them, pulled versions included.
export const installedPackages = new Map();

export function registerPackages(list) {
  for (const info of list) {
    // Bundled packages, with a collector or view-only (Reminders reads EventKit through the bridge).
    if (info.origin !== 'bundled') { installedPackages.set(info.id, info); continue; }
    packageInfo.set(info.id, info);
    titles[info.id] = info.title;
    if (!originalKinds.includes(info.id)) originalKinds.push(info.id);
    if (info.page === false) pagelessKinds.add(info.id); else pagelessKinds.delete(info.id);
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
