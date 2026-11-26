// Proxmox guest GPU telemetry over SSH, using the shared sampler.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { context } from '../../_shared/context.mjs';
import { validTarget, parseNvidia, nvidiaQuery, remote } from '../../_shared/gpu-sampler.mjs';

const socketDir = join(context.directory, 'ssh');
const runRemote = remote(socketDir);
export { validTarget };
export const query = nvidiaQuery;
export const parseGPUs = parseNvidia;
export async function sample(target, identityFile) {
  if (!validTarget(target)) throw Error("Invalid SSH destination");
  await mkdir(socketDir, {recursive: true, mode: 0o700});
  return parseNvidia(await runRemote(target, identityFile, nvidiaQuery));
}

export function monitorGPUs(read=sample) {
  const records = new Map();
  return function attach(vms,targets={},now=Date.now()) {
    const active = new Set();
    for (const vm of vms) {
      const settings = targets?.[vm.id];
      const target = typeof settings === "string" ? settings : settings?.target;
      const identityFile = settings?.identityFile;
      if (!validTarget(target)) continue;
      active.add(vm.id);
      let record = records.get(vm.id);
      if (!record || record.target !== target || record.identityFile !== identityFile) {
        record = {target,identityFile,next:0,pending:false,history:new Map(),state:{status:"Connecting"}};
        records.set(vm.id,record);
      }
      vm.gpu = record.state;
      if (record.pending || now < record.next) continue;
      record.pending = true;
      record.next = now+2000;
      read(target,identityFile).then(devices => {
        const at = Date.now();
        for (const gpu of devices) {
          const points = (record.history.get(gpu.uuid) ?? []).filter(p=>p.at>=at-60000);
          points.push({at,load:gpu.load});
          record.history.set(gpu.uuid,points);
          gpu.points = points;
        }
        record.state = {status:"Online",at,devices};
      }).catch(()=>{
        record.state = {status:"GPU telemetry offline"};
      }).finally(()=>{record.pending=false;});
    }
    for (const id of records.keys()) if (!active.has(id)) records.delete(id);
  };
}
