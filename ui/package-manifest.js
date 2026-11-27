// Helpers for normalized API version 2 manifests. Rust validates every manifest
// (src-tauri/src/package_manifest.rs); the UI only reads the result.

export const isV2 = manifest => manifest?.apiVersion === 2;

// The highest trust tier a manifest uses: view, declarative, connector or collector.
export function packageTier(manifest) {
  if (manifest.collector) return 'collector';
  if (manifest.connector) return 'connector';
  if (manifest.data?.length || manifest.actions?.length) return 'declarative';
  return 'view';
}

const capabilityLines = {
  settings: 'Has settings you choose for each placement.',
  'settings.choices': 'Lists what it finds, such as accounts, as choices in its settings.',
  keyboard: 'Can open the on-screen keyboard to ask you for text.',
  'mac.metrics': 'Reads this Mac’s CPU, GPU, memory and network activity.',
  reminders: 'Reads, checks off and adds your Apple Reminders. Bundled widgets only.',
  images: 'Shows images from that connection, such as posters and camera snapshots.',
  stream: 'Plays live streams from that connection, such as camera video.',
};

// Plain-language permissions for the install sheet. When `previous` is the installed
// version, capabilities it didn't have are marked as new.
export function permissionSummary(manifest, previous = null) {
  const lines = [];
  const sources = manifest.sources;
  if (sources?.max) lines.push(sources.max === 1 ? 'Uses one connection you choose.' : 'Uses up to ' + sources.max + ' connections you choose.');
  if (manifest.data?.length) lines.push('Reads ' + manifest.data.length + (manifest.data.length === 1 ? ' route' : ' routes') + ' from that connection.');
  if (manifest.actions?.length) lines.push('Can send ' + manifest.actions.length + (manifest.actions.length === 1 ? ' action' : ' actions') + ' to that connection when you tap.');
  if (manifest.connector) {
    lines.push('Runs its own code in a sandbox, with no access to your files or other widgets.');
    if (manifest.connector.hosts?.length) lines.push('Can also connect to: ' + manifest.connector.hosts.join(', ') + '.');
  }
  if (manifest.collector) lines.push('Runs a collector with full access to this Mac. Bundled widgets only.');
  for (const permission of manifest.permissions || []) {
    const line = capabilityLines[permission];
    if (!line) continue;
    const added = previous && !(previous.permissions || []).includes(permission);
    lines.push((added ? 'New: ' : '') + line);
  }
  if (!lines.length) lines.push('Shows its own view only. It can’t reach the network.');
  return lines;
}
