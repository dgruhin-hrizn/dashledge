// How a connection is named: the name the user typed, else what the server reports
// about itself, else the address's host. A blank connection name means automatic.
export function hostOf(address) {
  try { return new URL(address).hostname; } catch { return ''; }
}
export function displayName(source, serverName = '') {
  return source?.name?.trim() || String(serverName || '').trim() || hostOf(source?.address) || '';
}
// Label for connection lists in Settings, where the server's name isn't known yet.
export const connectionLabel = source => displayName(source);
