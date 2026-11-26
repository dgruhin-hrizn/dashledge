import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { route } from "./address.mjs";

const mailbox = "omlx.modelAction";
const maxAge = 30_000;
const modelActionTimeout = 600_000;

async function json(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function valid(command, now) {
  return command && typeof command.id === "string" && /^[a-f0-9]{32}$/.test(command.id) &&
    (command.action === "load" || command.action === "unload") &&
    typeof command.address === "string" &&
    typeof command.model === "string" && command.model.length > 0 && command.model.length <= 500 &&
    !/[\/\\]/.test(command.model) && command.model !== "." && command.model !== ".." &&
    Number.isFinite(command.at) && command.at <= now && now - command.at <= maxAge;
}

async function post(server, command, fetchApi) {
  try {
    const path = "/admin/api/models/" + encodeURIComponent(command.model) + "/" + command.action;
    const response = await fetchApi(route(server, path), {
      method: "POST",
      headers: server.key ? { Authorization: "Bearer " + server.key } : {},
      redirect: "error",
      signal: AbortSignal.timeout(modelActionTimeout),
    });
    if (response.status === 202) return { status: "success", message: "Unload queued by oMLX." };
    if (response.ok) return { status: "success", message: command.action === "load" ? "Model loaded." : "Model unloaded." };
    const messages = {
      400: "Model state changed. Try again after it refreshes.",
      401: "The main oMLX API key is required.",
      403: "The main oMLX API key is required.",
      404: "Model no longer available.",
      409: "Model is busy or unavailable.",
      507: "The model cannot fit within the memory limit.",
    };
    return { status: "error", message: messages[response.status] ?? "oMLX rejected the action (HTTP " + response.status + ")." };
  } catch {
    return { status: "error", message: "Action response lost. Check the model’s current state." };
  }
}

export async function modelControls({ preferences, state, fetchApi = fetch }) {
  const saved = await json(state, []);
  const recent = new Map(saved.map(([id, at]) => [id, at]));
  const results = new Map();
  const busy = new Set();

  async function consume(servers, inventory) {
    const settings = preferences();
    const now = Date.now();
    for (const [id, at] of recent) if (now - at > maxAge) recent.delete(id);
    for (const [instance, result] of results) {
      if (result.status !== "pending" && now - result.at > maxAge) results.delete(instance);
    }
    for (const [instance, storage] of Object.entries(settings?.widgetStorage ?? {})) {
      if (!instance.startsWith("omlx-dashboard@") || typeof storage?.[mailbox] !== "string") continue;
      let command;
      try {
        command = JSON.parse(storage[mailbox]);
      } catch {
        continue;
      }
      if (!valid(command, now) || recent.has(command.id)) continue;
      const server = servers.find(({ base }) => base === command.address);
      const current = inventory.find(({ address }) => address === command.address);
      const model = current?.models?.find(({ id }) => id === command.model);
      const finish = (result) => results.set(instance, { id: command.id, at: Date.now(), ...result });

      // Persist claims before sending a POST so restarting the collector never replays a tap.
      const claimed = [...recent, [command.id, command.at]];
      const temporary = state + "." + process.pid + ".tmp";
      try {
        await writeFile(temporary, JSON.stringify(claimed), { mode: 0o600 });
        await rename(temporary, state);
      } finally {
        await rm(temporary, { force: true });
      }
      recent.set(command.id, command.at);

      if (!server || !current?.canControl || !model?.controllable) {
        finish({ status: "error", message: "Model controls unavailable for this server." });
      } else if (busy.has(server.base) || model.loading) {
        finish({ status: "error", message: "A model action is already in progress." });
      } else if (model.loaded === (command.action === "load")) {
        finish({ status: "success", message: "Model is already " + (model.loaded ? "loaded." : "unloaded.") });
      } else if (command.action === "load" && model.loadFit === false) {
        finish({ status: "error", message: "Not enough memory headroom. Unload a model first." });
      } else {
        busy.add(server.base);
        finish({ status: "pending" });
        void post(server, command, fetchApi).then(finish).finally(() => busy.delete(server.base));
      }
    }
  }

  return {
    consume,
    receipts: () => Object.fromEntries(results),
  };
}
