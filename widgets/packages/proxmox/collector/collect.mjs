import { writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connect, summarize } from "./api.mjs";

import { monitorGPUs } from "./gpu.mjs";
const attachGPUs = monitorGPUs();
import { context } from '../../_shared/context.mjs';
const server = context.sources[0];
const address = new URL(server.address);
const split = server.key.indexOf('=');
const config = {
  host: address.hostname, port: Number(address.port || 443),
  tokenId: server.key.slice(0, split), secret: server.key.slice(split + 1),
  ca: server.ca || undefined, gpuGuests: server.gpuGuests,
};
const output = join(context.directory, 'snapshot.js');
const history = [];
let data = null, sampleAt = null;
do {
  let issue = null;
  try {
    const get = await connect(config);
    const [resources,status] = await Promise.all([get("/cluster/resources"),get("/cluster/status").catch(()=>null)]);
    data = summarize(resources,status);
    attachGPUs(data.runningVMs,config.gpuGuests);
    sampleAt = Date.now();
  } catch (e) {
    issue = e.code === "ENOENT" ? "Configuration or CA file missing" :
      e.message.startsWith("Proxmox returned HTTP") || e.message.startsWith("No visible nodes") ? e.message :
      "Connection failed · check host, TLS and token";
  }
  const at = Date.now();
  history.push({at,cpu:issue ? null : data.cpu, ram:issue || !data.capacity ? null : data.used/data.capacity});
  while (history.length && history[0].at < at-600000) history.shift();
  const snapshot = {at,sampleAt,issue,data,history};
  {
    const temp = output+"."+process.pid+".tmp";
    await writeFile(temp,"window.proxmoxSample?.("+JSON.stringify(snapshot)+");\n",{mode:0o600});
    await rename(temp,output);
  }
  await delay(5000);
} while (true);
