// Shared between the collector and the widget.
function assignment(d){
  if(/^disk\d+$/i.test(d.name))return 'Array data';
  if(/^parity\d*$/i.test(d.name))return 'Array parity';
  if(d.role==='cache'||d.role==='pool'||(d.device && /^\/mnt\/[^/]+$/.test(d.mount_point||'')&&!['/mnt/user','/mnt/user0','/mnt/disks','/mnt/remotes'].includes(d.mount_point)))return 'Pool devices';
  return 'Other devices';
}
globalThis.goliathAssignment=assignment;
