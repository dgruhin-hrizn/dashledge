// Helpers for normalized API version 2 manifests. Rust validates every manifest
// (src-tauri/package-core/src/manifest.rs); the UI only reads the result.

export const isV2 = manifest => manifest?.apiVersion === 2;

// One line of facts for the install sheet: version, license and home page host.
export function packageFacts(manifest) {
  const facts = [];
  if (manifest.version) facts.push('Version ' + manifest.version);
  if (manifest.license) facts.push(manifest.license + ' license');
  if (manifest.homepage) {
    try { facts.push(new URL(manifest.homepage).host); } catch {}
  }
  if (manifest.minAppVersion) facts.push('Needs Dashledge ' + manifest.minAppVersion + ' or later');
  return facts.join(' · ');
}

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
  reminders: 'Reads, checks off and adds your Apple Reminders, and can say them aloud when they’re due. Bundled widgets only.',
  images: 'Shows images from that connection, such as posters and camera snapshots.',
  stream: 'Plays live streams from that connection, such as camera video.',
  speech: 'Speak aloud: can say things in your Dashledge voice while it’s on screen.',
};

// Plain-language permissions for the install sheet. When the package replaces an
// installed version, Rust lists what it adds in `manifest.added` ({kind, value} grants)
// and each line it touches is marked as new. Without that list, `previous` (the
// layout's catalog entry) marks capabilities only.
export function permissionSummary(manifest, previous = null) {
  const lines = [];
  const added = Array.isArray(manifest.added) ? manifest.added : null;
  const addedOf = kind => added ? added.filter(grant => grant.kind === kind).map(grant => grant.value) : [];
  const push = (line, isNew) => lines.push((isNew ? 'New: ' : '') + line);
  const sources = manifest.sources;
  if (sources?.max) push(sources.max === 1 ? 'Uses one connection you choose.' : 'Uses up to ' + sources.max + ' connections you choose.', addedOf('connections').length);
  if (sources?.types?.length) {
    const names = sources.types.map(type => type.label);
    push('Connects to ' + (names.length > 1 ? names.slice(0, -1).join(', ') + ' or ' + names.at(-1) : names[0]) + '.', addedOf('connectionType').length);
  }
  if (addedOf('auth').length) push('Changes how it sends your saved key or sign-in to that connection.', true);
  if (manifest.data?.length) push('Reads ' + manifest.data.length + (manifest.data.length === 1 ? ' route' : ' routes') + ' from that connection.', addedOf('data').length);
  if (manifest.actions?.length) push('Can send ' + manifest.actions.length + (manifest.actions.length === 1 ? ' action' : ' actions') + ' to that connection when you tap.', addedOf('action').length);
  if (manifest.connector) {
    push('Runs its own code in a sandbox, with no access to your files or other widgets.', addedOf('connector').length);
    const hosts = manifest.connector.hosts || [], newHosts = addedOf('host');
    const oldHosts = hosts.filter(host => !newHosts.includes(host));
    if (oldHosts.length) push('Can also connect to: ' + oldHosts.join(', ') + '.', false);
    if (newHosts.length) push('Can also connect to: ' + newHosts.join(', ') + '.', true);
  }
  if (addedOf('command').length) push('Adds commands its view can run: ' + addedOf('command').join(', ') + '.', true);
  if (manifest.collector) lines.push('Runs a collector with full access to this Mac. Bundled widgets only.');
  const permissions = manifest.permissions || [];
  for (const permission of permissions) {
    const line = capabilityLines[permission];
    if (!line) continue;
    const isNew = added ? addedOf('permission').includes(permission) : previous && !(previous.permissions || []).includes(permission);
    push(line, isNew);
  }
  if (addedOf('image').length && !addedOf('permission').includes('images') && permissions.includes('images')) push('Loads more kinds of images from that connection.', true);
  if (addedOf('stream').length && !addedOf('permission').includes('stream') && permissions.includes('stream')) push('Opens more kinds of live streams from that connection.', true);
  if (!lines.length) lines.push('Shows its own view only. It can’t reach the network.');
  return lines;
}
