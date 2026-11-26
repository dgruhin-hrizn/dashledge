// Proxmox GPU guests: which VMs Dashledge reads GPU load from over SSH. Saved on the
// Proxmox connection as gpuGuests {vmid: "user@host" | {target, identityFile}}, the
// shape the Proxmox collector and ComfyUI's GPU pairing read.

const TARGET = /^(?:[a-z_][a-z0-9_.-]*@)?[a-z0-9][a-z0-9.-]*$/i;

// Editable rows from a saved mapping, ordered by VM ID.
export function guestRows(gpuGuests) {
  return Object.entries(gpuGuests || {})
    .map(([vmid, value]) => ({vmid, target: typeof value === 'string' ? value : value?.target || '',
      identityFile: typeof value === 'string' ? '' : value?.identityFile || ''}))
    .sort((a, b) => Number(a.vmid) - Number(b.vmid));
}

// The mapping to save from edited rows. Blank rows are dropped; anything else must be
// a valid VM ID and SSH destination. Throws an Error naming the row's problem.
export function parseGuests(rows) {
  const out = {};
  for (const row of rows) {
    const vmid = String(row.vmid ?? '').trim(), target = String(row.target ?? '').trim();
    const identityFile = String(row.identityFile ?? '').trim();
    if (!vmid && !target && !identityFile) continue;
    if (!/^[1-9][0-9]{2,8}$/.test(vmid)) throw Error('Enter a VM ID of 100 or more for each GPU guest.');
    if (Object.hasOwn(out, vmid)) throw Error('VM ' + vmid + ' is listed twice.');
    if (!TARGET.test(target)) throw Error('Enter VM ' + vmid + '’s SSH destination as user@host.');
    if (identityFile && !/^(~|\/)[^\0]*$/.test(identityFile)) throw Error('Enter the full path of VM ' + vmid + '’s SSH key file.');
    out[vmid] = identityFile ? {target, identityFile} : target;
  }
  return out;
}
