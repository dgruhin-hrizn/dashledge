import { rename, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { modelControls } from "./model-control.mjs";

import { context, preferences } from '../../_shared/context.mjs';
const interval = 1000;
const finite = (value) => Number.isFinite(value) && value >= 0 ? value : null;
const positive = (value) => finite(value) || null;
const rows = (value) => Array.isArray(value) ? value : [];
const label = (value) => typeof value === "string" ? value.slice(0, 500) : null;

async function request(server, path, fetchJson) {
  try {
    const response = await fetchJson(server.origin + path, {
      headers: server.key ? { Authorization: "Bearer " + server.key } : {},
      redirect: "error",
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return { status: response.status };
    const data = await response.json();
    return data && typeof data === "object" ? { data } : {};
  } catch (error) {
    return { network: error.cause?.code === "EPERM" || error.cause?.code === "EACCES"
      ? "Network access denied." : "Connection failed or timed out." };
  }
}

function activityModel(model, activity, wasLoaded) {
  const loading = Boolean(activity?.is_loading ?? model.is_loading);
  const loaded = activity && !loading ? true : Boolean(model.loaded ?? wasLoaded);
  const measured = loaded ? positive(activity?.actual_size) ?? positive(model.actual_size) : null;
  const estimate = positive(model.resident_estimated_size) ??
    positive(activity?.estimated_size) ?? positive(model.estimated_size);
  const generating = rows(activity?.generating);
  const prefilling = rows(activity?.prefilling);
  const rates = generating.map((row) => finite(row.tokens_per_second)).filter((rate) => rate !== null);
  return {
    id: model.id,
    name: label(model.model_alias) || model.id,
    type: label(model.model_type ?? model.engine_type),
    loading,
    loaded,
    controllable: typeof model.loaded === "boolean",
    pinned: Boolean(activity?.pinned ?? model.pinned),
    distributed: Boolean(activity?.cluster || model.cluster || model.distributed),
    actualBytes: measured,
    estimatedBytes: estimate,
    context: positive(model.max_context_window ?? model.model_context_length),
    active: finite(activity?.active_requests),
    queued: finite(activity?.waiting_requests),
    idleTtl: finite(activity?.ttl_remaining_seconds),
    idleSeconds: finite(activity?.idle_seconds),
    decode: activity ? (rates.length ? rates.reduce((sum, rate) => sum + rate, 0) : generating.length ? null : 0) : null,
    loadingElapsed: finite(activity?.loading_elapsed_seconds),
    loadingRemaining: finite(activity?.loading_remaining_seconds_estimate),
    generating: generating.length,
    generations: generating.map(row => ({
      id: label(row.request_id), tokens: finite(row.generated_tokens), elapsed: finite(row.elapsed_seconds),
      rate: finite(row.tokens_per_second)
    })),
    prefilling: prefilling.map((row) => ({
      done: finite(row.processed), total: finite(row.total),
      rate: finite(row.speed), eta: finite(row.eta),
    })),
  };
}

export async function pollServer(server, fetchJson = fetch) {
  const identity = { address: server.origin, name: server.name };
  if (server.configurationError) return { ...identity, error: server.configurationError };
  const [statusResponse, modelsResponse, activityResponse] = await Promise.all([
    request(server, "/api/status", fetchJson),
    request(server, "/v1/models/status", fetchJson),
    request(server, "/admin/api/activity", fetchJson),
  ]);
  const status = statusResponse.data?.status === "ok" ? statusResponse.data : null;
  const inventory = Array.isArray(modelsResponse.data?.models) ? modelsResponse.data.models : null;
  const candidate = activityResponse.data?.active_models;
  const activity = Array.isArray(candidate?.models) ? candidate : null;
  if (!status && !inventory && !activity) {
    const responses = [statusResponse, modelsResponse, activityResponse];
    const auth = responses.some(({ status }) => status === 401 || status === 403);
    return { ...identity, error: auth ? "Check the oMLX API key." :
      responses.some(({ status }) => status === 503) ? "oMLX is starting or unavailable." :
      statusResponse.network ?? "oMLX metrics are unavailable at this address." };
  }
  const identified = new Map();
  const resident = new Set(rows(status?.loaded_models));
  for (const id of resident) {
    if (label(id)) identified.set(id, { model: { id } });
  }
  for (const model of inventory ?? []) {
    if (label(model?.id) && !model.source_model_id && model.source_type !== "builtin") {
      identified.set(model.id, { model });
    }
  }
  for (const live of activity?.models ?? []) {
    if (label(live?.id)) identified.set(live.id, { model: identified.get(live.id)?.model ?? { id: live.id }, live });
  }
  const models = [...identified.values()]
    .map(({ model, live }) => activityModel(model, live, resident.has(model.id)))
    .sort((a, b) => Number(b.loaded || b.loading) - Number(a.loaded || a.loading) || a.name.localeCompare(b.name));
  const decode = models.filter((model) => model.decode !== null).reduce((sum, model) => sum + model.decode, 0);
  const hasDecode = models.some((model) => model.decode !== null && model.generating > 0);
  const hasActivity = Boolean(activity);
  const pressure = activity?.memory_pressure;
  const poolBytes = finite(status?.model_memory_used ?? modelsResponse.data?.current_model_memory);
  const processBytes = pressure?.enabled ? finite(pressure.current_bytes) : null;
  const accountedBytes = poolBytes ?? (processBytes === null ? finite(activity?.model_memory_used) : null);
  const limit = positive(activity?.model_memory_max) ?? positive(status?.model_memory_max) ??
    positive(modelsResponse.data?.final_ceiling);
  const used = Math.max(accountedBytes ?? 0, processBytes ?? 0);
  const headroomBytes = limit !== null && (accountedBytes !== null || processBytes !== null)
    ? Math.max(0, limit - used) : null;
  for (const model of models) {
    model.loadFit = !model.loaded && !model.loading && model.estimatedBytes !== null && headroomBytes !== null
      ? model.estimatedBytes <= headroomBytes : null;
  }
  return {
    ...identity,
    at: Date.now(),
    version: label(status?.version),
    uptime: finite(status?.uptime_seconds),
    discovered: finite(status?.models_discovered) ?? (inventory ? models.length : null),
    loaded: finite(status?.models_loaded) ?? models.filter((model) => model.loaded).length,
    models,
    canControl: Boolean(inventory && activity),
    poolBytes: accountedBytes,
    processBytes,
    limit,
    headroomBytes,
    pressure: pressure?.enabled ? label(pressure.pressure_level) : null,
    active: finite(activity?.total_active_requests ?? status?.active_requests),
    queued: finite(activity?.total_waiting_requests ?? status?.waiting_requests),
    liveDecode: hasActivity && (hasDecode || !models.some((model) => model.generating > 0)) ? decode : null,
    avgDecode: finite(status?.avg_generation_tps),
    avgPrefill: finite(status?.avg_prefill_tps),
    requests: finite(status?.total_requests),
    input: finite(status?.total_prompt_tokens),
    output: finite(status?.total_completion_tokens),
    cached: finite(status?.total_cached_tokens),
    hitRate: positive(status?.total_prompt_tokens) ? finite(status?.cache_efficiency) : null,
    notice: !hasActivity ? ([401, 403].includes(activityResponse.status)
      ? "Live activity requires the main oMLX API key." : "Live activity is unavailable on this server.") :
      !status ? "Session totals are unavailable on this server." : null,
  };
}

export async function weeklyUsage(server, fetchJson = fetch) {
  const {data} = await request(server, "/admin/api/usage?range=7d", fetchJson);
  if (data?.enabled === false) return {disabled: true};
  if (!data || data.available === false ||
      !Array.isArray(data.heatmap) || !Array.isArray(data.models)) return null;
  // `end` is the server's next local midnight with its UTC offset.
  const zone = typeof data.end === "string" ? /([+-])(\d{2}):(\d{2})$/.exec(data.end) : null;
  return {
    offsetMinutes: zone ? (zone[1] === "-" ? -1 : 1) * (Number(zone[2]) * 60 + Number(zone[3])) : null,
    days: data.heatmap.filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day.date) &&
      Array.isArray(day.tokens) && day.tokens.length === 24).map(day => ({
      date: day.date, tokens: day.tokens.map(finite)
    })),
    speeds: data.models.filter(model => label(model.model_id) && finite(model.generation_tps) !== null)
      .map(model => ({name: label(model.model_id), rate: model.generation_tps}))
      .sort((a,b) => b.rate - a.rate)
  };
}

async function readMacSpecs() {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await promisify(execFile)("/usr/sbin/system_profiler",
      ["SPHardwareDataType", "SPDisplaysDataType", "-json"], { timeout: 5000 });
    const report = JSON.parse(stdout);
    const machine = report.SPHardwareDataType?.[0];
    if (!machine) return null;
    const graphics = report.SPDisplaysDataType?.find(gpu => gpu.sppci_model === machine.chip_type);
    return {
      model: label(machine.machine_name),
      chip: label(machine.chip_type ?? machine.cpu_type),
      cpu: positive(Number(/^proc (\d+)/.exec(machine.number_processors)?.[1])),
      gpu: positive(Number(graphics?.sppci_cores)),
      memory: label(machine.physical_memory),
    };
  } catch {
    return null;
  }
}

async function run() {
  const output = join(context.directory, 'snapshot.js');
  const servers = context.sources.map(s => ({ origin: new URL(s.address).origin, name: s.name, key: s.key }));
  const mac = await readMacSpecs();
  const previous = new Map();
  const weeks = new Map();
  const controls = await modelControls({ preferences, state: join(context.directory, 'model-actions.json') });
  async function publish() {
    const results = await Promise.all(servers.map((server) => pollServer(server)));
    for (const [index,result] of results.entries()) {
      if (result.error) continue;
      const server = servers[index];
      let entry = weeks.get(server.origin);
      if (!entry || entry.key !== server.key || Date.now() >= entry.next) {
        // `undefined` until the first fetch lands, so the view can say it is loading.
        entry = {key:server.key, next:Date.now()+60000, data:entry?.key === server.key ? entry?.data : undefined};
        weeks.set(server.origin,entry);
        void weeklyUsage(server).then(data => { entry.data = data; });

      }
      result.week = entry.data;
    }
    await controls.consume(servers, results);
    for (const result of results) {
      if (result.error && previous.has(result.address)) {
        Object.assign(result, { last: previous.get(result.address) });
      } else if (!result.error) {
        previous.set(result.address, result);
      }
    }
    const snapshot = { schema: 1, at: Date.now(), mac, servers: results, actions: controls.receipts() };
    const temporary = join(dirname(output), ".snapshot-" + process.pid + ".tmp");
    try {
      await writeFile(temporary, "window.omlxWidgetSnapshot?.(" + JSON.stringify(snapshot) + ");\n", { mode: 0o600 });
      await rename(temporary, output);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async function tick() {
    const start = Date.now();
    try {
      await publish();
    } catch (error) {
      console.error("Could not publish oMLX snapshot:", error.message);
    }
    setTimeout(tick, Math.max(100, interval - (Date.now() - start)));
  }
  await tick();
}

await run();
