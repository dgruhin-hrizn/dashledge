import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const run = promisify(execFile);
import { context } from '../../_shared/context.mjs';
const socketDir = join(context.directory, 'ssh');
export const query = "nvidia-smi --query-gpu=uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits";
export const validTarget = value => typeof value === "string" && /^(?:[a-z_][a-z0-9_.-]*@)?[a-z0-9][a-z0-9.-]*$/i.test(value);
function numeric(value) {
  const parsed = value.trim() === "" ? NaN : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
export function parseGPUs(output) {
  const devices = [];
  for (const line of output.trim().split(/\r?\n/)) {
    const fields = line.split(",").map(s => s.trim());
    if (fields.length !== 7 || !fields[0].startsWith("GPU-")) continue;
    const [uuid,name] = fields;
    const [load,used,total,temp,watts] = fields.slice(2).map(numeric);
    devices.push({uuid,name,load,used,total,temp,watts});
  }
  if (!devices.length) throw Error("No NVIDIA readings");
  return devices;
}
export async function sample(target,identityFile) {
  if (!validTarget(target)) throw Error("Invalid SSH destination");
  await mkdir(socketDir,{recursive:true,mode:0o700});
  const {stdout} = await run("/usr/bin/ssh",["-T","-o","BatchMode=yes","-o","StrictHostKeyChecking=yes",
    "-o","ClearAllForwardings=yes","-o","ForwardAgent=no","-o","ConnectTimeout=3","-o","ControlMaster=auto",
    "-o","ControlPersist=30","-o","ControlPath="+join(socketDir,"%C"),...(identityFile ? ["-o","IdentitiesOnly=yes","-i",identityFile] : []),target,query],
    {timeout:4500,maxBuffer:65536});
  return parseGPUs(stdout);
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
