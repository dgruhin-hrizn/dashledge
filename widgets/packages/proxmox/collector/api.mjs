import http from "node:http";
import https from "node:https";

// The cluster's base address as Dashledge resolved it, the same one Test used. A path
// (a reverse-proxy prefix) is kept, and API routes join beneath it.
export function endpoint(address) {
  let base;
  try { base = new URL(address); } catch { throw Error("Enter the cluster URL."); }
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash)
    throw Error("Enter the cluster URL without credentials or a query.");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return base;
}
export const apiURL = (base, path) => new URL("api2/json/" + path.replace(/^\/+/, ""), base);

export async function connect(config) {
  const base = endpoint(config.address);
  if (typeof config.tokenId !== "string" || typeof config.secret !== "string" || !/^[^\s!=]+@[^\s!=]+![^\s!=]+$/.test(config.tokenId) || !/^[^\s=]+$/.test(config.secret)) throw Error("Check token ID and secret.");
  const ca = config.ca;
  return path => new Promise((resolve, reject) => {
    const client = base.protocol === "http:" ? http : https;
    const req = client.get(apiURL(base, path), {
      ca, headers:{ Authorization:"PVEAPIToken=" + config.tokenId + "=" + config.secret },
      signal:AbortSignal.timeout(8000)
    }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(Error("Proxmox returned HTTP " + res.statusCode));
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("error", reject);
      res.on("data", chunk => {
        body += chunk;
        if (body.length > 16_000_000) req.destroy(Error("Proxmox response too large"));
      });
      res.on("end", () => {
        try {
          const {data} = JSON.parse(body);
          if (!Array.isArray(data)) throw Error("Unexpected Proxmox response");
          resolve(data);
        } catch (error) { reject(error); }
      });
    });
    req.on("error",reject);
  });
}

const number = v => Number.isFinite(v) && v >= 0 ? v : null;
export function summarize(resources, status) {
  const guests = resources.filter(r => ["qemu","lxc"].includes(r.type) && !Number(r.template));
  const runningVMs = guests
    .filter(g => g.type === "qemu" && g.status === "running")
    .map(g => ({
      id:g.vmid, name:g.name || ("VM " + g.vmid), node:g.node,
      cpu:number(g.cpu), cores:number(g.maxcpu), used:number(g.mem), capacity:number(g.maxmem)
    }))
    .sort((a,b) => a.name.localeCompare(b.name, undefined, {numeric:true}) || a.id-b.id);
  const nodes = resources.filter(r => r.type === "node").map(r => ({
    name:r.node, online:r.status === "online", cpu:number(r.cpu), cores:number(r.maxcpu),
    used:number(r.mem), capacity:number(r.maxmem), uptime:number(r.uptime),
    vms:guests.filter(g => g.node === r.node && g.type === "qemu" && g.status === "running").length
  })).sort((a,b) => a.name.localeCompare(b.name, undefined, {numeric:true}));
  if (!nodes.length) throw Error("No visible nodes. Check PVEAuditor permissions.");
  const online = nodes.filter(n => n.online);
  const cores = online.reduce((s,n) => s+(n.cores ?? 0),0);
  const cpu = cores && online.every(n => n.cores > 0 && n.cpu !== null)
    ? online.reduce((s,n) => s+n.cores*n.cpu,0)/cores : null;
  const memoryKnown = online.length > 0 && online.every(n => n.capacity > 0 && n.used !== null);
  const used = memoryKnown ? online.reduce((s,n) => s+n.used,0) : null;
  const capacity = memoryKnown ? online.reduce((s,n) => s+n.capacity,0) : null;
  const cluster = status?.find(r => r.type === "cluster");
    // The name the cluster reports, else its only node's; null lets the view use the host.
  return {name:cluster?.name ?? (nodes.length === 1 ? nodes[0].name : null),
    quorum:cluster?.quorate == null ? null : Boolean(Number(cluster.quorate)),
    nodes, cpu, used, capacity, online:online.length,
    runningVMs, running:runningVMs.length,
    containers:guests.filter(g=>g.type==="lxc" && g.status==="running").length,
    total:guests.filter(g=>g.type==="qemu").length};
}
