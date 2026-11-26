// GPU load from wherever a GPU actually is: this Mac, or another machine over SSH.
// Shared by the ComfyUI and Proxmox collectors. Nothing here imports the collector
// context, so the parsers and probe order can be tested directly.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hostname } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);

export const validTarget = value => typeof value === "string" && /^(?:[a-z_][a-z0-9_.-]*@)?[a-z0-9][a-z0-9.-]*$/i.test(value);
// A 0–100 reading from a number or the first number in a string ("17", "17 %").
const percent = value => {
  const n = typeof value === "number" ? value : Number(String(value ?? "").match(/\d+(?:\.\d+)?/)?.[0] ?? NaN);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
};

// ---- Output parsers: each returns [{name, load}] and throws when it finds nothing ----

export const nvidiaQuery = "nvidia-smi --query-gpu=uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits";
export function parseNvidia(output) {
  const numeric = v => { const n = v.trim() === "" ? NaN : Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };
  const devices = [];
  for (const line of output.trim().split(/\r?\n/)) {
    const fields = line.split(",").map(s => s.trim());
    if (fields.length !== 7 || !fields[0].startsWith("GPU-")) continue;
    const [uuid, name] = fields;
    const [load, used, total, temp, watts] = fields.slice(2).map(numeric);
    devices.push({uuid, name, load, used, total, temp, watts});
  }
  if (!devices.length) throw Error("No NVIDIA readings");
  return devices;
}

// amd-smi metric --usage --json: [{gpu, usage: {gfx_activity: {value}}}]
export function parseAmdSmi(output) {
  const rows = JSON.parse(output);
  const devices = (Array.isArray(rows) ? rows : [rows]).map((row, i) => ({
    name: "AMD GPU " + (row.gpu ?? i),
    load: percent(row.usage?.gfx_activity?.value ?? row.usage?.gfx_activity ?? row.usage?.gfx_usage?.value),
  })).filter(d => d.load != null);
  if (!devices.length) throw Error("No AMD readings");
  return devices;
}

// rocm-smi --showuse --json: {card0: {"GPU use (%)": "12"}}
export function parseRocm(output) {
  const devices = Object.entries(JSON.parse(output))
    .filter(([key]) => /^card\d+$/.test(key))
    .map(([key, row]) => ({name: "AMD GPU " + key.slice(4), load: percent(row["GPU use (%)"])}))
    .filter(d => d.load != null);
  if (!devices.length) throw Error("No ROCm readings");
  return devices;
}

// xpu-smi stats -d 0 -j: {device_level: [{metrics_type: "XPUM_STATS_GPU_UTILIZATION", value}]}
export function parseXpu(output) {
  const stats = JSON.parse(output);
  const row = stats.device_level?.find(m => m.metrics_type === "XPUM_STATS_GPU_UTILIZATION");
  const load = percent(row?.value);
  if (load == null) throw Error("No Intel readings");
  return [{name: "Intel GPU " + (stats.device_id ?? 0), load}];
}

// ioreg -r -c IOAccelerator -d 1: "Device Utilization %"=37 inside PerformanceStatistics.
export function parseIoreg(output) {
  const devices = [...output.matchAll(/"Device Utilization %"\s*=\s*(\d+)/g)]
    .map((match, i) => ({name: "Apple GPU" + (i ? " " + (i + 1) : ""), load: percent(match[1])}))
    .filter(d => d.load != null);
  if (!devices.length) throw Error("No Apple GPU readings");
  return devices;
}

// Windows GPU Engine counters summed per adapter, printed as one number per line.
export const windowsQuery = "powershell -NoProfile -Command \"(Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage').CounterSamples | Measure-Object CookedValue -Sum | ForEach-Object { [math]::Round([math]::Min(100, $_.Sum), 1) }\"";
export function parseWindows(output) {
  const load = percent(output.trim().split(/\r?\n/).at(-1));
  if (load == null) throw Error("No Windows GPU readings");
  return [{name: "GPU", load}];
}

// Tried in order on a remote host until one answers; the winner is remembered.
export const probes = [
  {tool: "nvidia-smi", command: nvidiaQuery, parse: parseNvidia},
  {tool: "amd-smi", command: "amd-smi metric --usage --json", parse: parseAmdSmi},
  {tool: "rocm-smi", command: "rocm-smi --showuse --json", parse: parseRocm},
  {tool: "xpu-smi", command: "xpu-smi stats -d 0 -j", parse: parseXpu},
  {tool: "ioreg", command: "ioreg -r -c IOAccelerator -d 1", parse: parseIoreg},
  {tool: "Windows counters", command: windowsQuery, parse: parseWindows},
];

export function sshArgs(socketDir, target, identityFile, command) {
  return ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ClearAllForwardings=yes",
    "-o", "ForwardAgent=no", "-o", "ConnectTimeout=3", "-o", "ControlMaster=auto", "-o", "ControlPersist=30",
    "-o", "ControlPath=" + join(socketDir, "%C"),
    ...(identityFile ? ["-o", "IdentitiesOnly=yes", "-i", identityFile] : []), target, command];
}

// Run a command on `target` over SSH. `exec` is injectable for tests.
export function remote(socketDir, exec = run) {
  return (target, identityFile, command) => {
    if (!validTarget(target)) return Promise.reject(Error("Invalid SSH destination"));
    return exec("/usr/bin/ssh", sshArgs(socketDir, target, identityFile, command), {timeout: 4500, maxBuffer: 262144})
      .then(r => r.stdout);
  };
}

// Sample a remote GPU, detecting which tool the host has. Returns {tool, devices}.
export function remoteSampler(execRemote) {
  const known = new Map(); // target → probe index that answered
  return async function sample(target, identityFile) {
    const start = known.get(target);
    const order = start == null ? probes.map((_, i) => i) : [start, ...probes.map((_, i) => i).filter(i => i !== start)];
    let lastError = Error("No GPU tool answered");
    for (const index of order) {
      try {
        const devices = probes[index].parse(await execRemote(target, identityFile, probes[index].command));
        known.set(target, index);
        return {tool: probes[index].tool, devices};
      } catch (error) {
        lastError = error;
        if (/Invalid SSH|Permission denied|Host key|Connection refused|timed out|Could not resolve/i.test(String(error.stderr || error.message))) break;
      }
    }
    known.delete(target);
    throw lastError;
  };
}

// This Mac's GPU load, read the way the Mac instruments read it.
export async function sampleThisMac(exec = run) {
  const {stdout} = await exec("/usr/sbin/ioreg", ["-r", "-c", "IOAccelerator", "-d", "1"], {timeout: 3000, maxBuffer: 1 << 20});
  return {tool: "ioreg", devices: parseIoreg(stdout)};
}

// Is this address served by this Mac?
export function isThisMac(host, machine = hostname()) {
  const name = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  const local = machine.toLowerCase().replace(/\.local$/, "");
  return ["localhost", "::1", "0.0.0.0"].includes(name) || /^127\./.test(name) || name === local || name === local + ".local";
}
