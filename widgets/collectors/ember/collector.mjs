import { context } from "../context.mjs";
import { execFile, execFileSync } from "node:child_process";

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePlanFile, fallbackTitleFromPath } from "./shared.mjs";
import { codeFontState, WEBVIEW_CODE_FONT_STACK } from "./shared.mjs";
import { formatClock } from "./shared.mjs";
import { chatEnv } from "./shared.mjs";
import { linkSpans } from "./shared.mjs";
import { pathAttempts } from "./shared.mjs";
import { transcriptFiles, transcriptTails } from "./transcripts.mjs";

const root = join(homedir(), "Library/Application Support/Ember");
const output = join(context.directory, 'snapshot.js');
const db = join(root, "User/globalStorage/ember.ember-agent/ember.db");
const tick = 3000;
import { parse } from "./shared.mjs";
// Retain only rendering keys. Claude settings files can also contain credentials.
const settingFiles = new Map();
function renderingKeys(path, keys) {
  try {
    const info = statSync(path);
    const stamp = info.mtimeMs + ":" + info.size;
    const prior = settingFiles.get(path);
    if (prior?.stamp === stamp) return prior.values;
    const errors = [];
    const raw = parse(readFileSync(path, "utf8"), errors, { allowTrailingComma: true });
    if (errors.length) return prior?.values ?? {};
    const values = Object.fromEntries(keys.filter(k => raw?.[k] !== undefined).map(k => [k,raw[k]]));
    settingFiles.set(path, { stamp, values });
    return values;
  } catch { settingFiles.delete(path); return {}; }
}
const emberKeys = ["editor.fontFamily", ...["density","textSize","maxWidth","jumpRail","expandToolCalls","expandThinking","expandSubagents","foldTurns","groupNarration"].map(k => "ember.chat." + k)];
const interfaceKeys = ["showMessageTimestamps","prefersReducedMotion","timeFormat","timeZone"];
function chatSettings(workspace, cwd) {
  const config = { ...renderingKeys(join(root,"User/settings.json"), emberKeys),
    ...(workspace ? renderingKeys(join(workspace,".vscode/settings.json"),emberKeys) : {}) };
  const userDir = process.env.CLAUDE_CONFIG_DIR || join(process.env.EMBER_CLAUDE_HOME || homedir(), ".claude");
  const ui = { ...renderingKeys(join(userDir,"settings.json"),interfaceKeys),
    ...(cwd ? renderingKeys(join(cwd,".claude/settings.json"),interfaceKeys) : {}),
    ...(cwd ? renderingKeys(join(cwd,".claude/settings.local.json"),interfaceKeys) : {}),
    ...renderingKeys("/Library/Application Support/ClaudeCode/managed-settings.json",interfaceKeys) };
  const family = typeof config["editor.fontFamily"] === "string" ? config["editor.fontFamily"] : "";
  return { ...chatEnv(key => config["ember.chat." + key]),
    fontFamily: codeFontState(family).font === "ember" ? WEBVIEW_CODE_FONT_STACK : family,
    showMessageTimestamps: ui.showMessageTimestamps === true, reducedMotion: ui.prefersReducedMotion === true,
    timeFormat: typeof ui.timeFormat === "string" ? ui.timeFormat : undefined,
    timeZone: typeof ui.timeZone === "string" ? ui.timeZone : undefined };
}

function read(path, fallback) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function json(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function query(sql) {
  try {
    const data = execFileSync("/usr/bin/sqlite3", ["-readonly", "-json", "-cmd", ".timeout 1500", db, sql], {
      encoding: "utf8", timeout: 6000, stdio: ["ignore", "pipe", "pipe"],
    });
    return data ? JSON.parse(data) : [];
  } catch (error) {
    // Stable and beta versions can have different schema versions. Other views can still refresh.
    console.error("Ember widget: a database query failed.", error.stderr?.trim() || error.message);
    return null;
  }
}

function windows(now) {
  const folder = join(root, "ember-attention");
  let names;
  try {
    names = readdirSync(folder);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const open = new Map((query("SELECT pid, json FROM window_chats") ?? []).map((row) => [row.pid, json(row.json)]));
  return names.flatMap((name) => {
    if (!/^\d+\.json$/.test(name)) return [];
    const item = json(read(join(folder, name), ""));
    if (item?.v !== 1 || name !== item.pid + ".json" || now - item.at >= 180_000 || !alive(item.pid)) return [];
    const tabs = open.get(item.pid);
    const working = Number(read(join(root, "ember-running", String(item.pid)), "0"));
    return [{
      pid: item.pid,
      folder: item.chatsFolder ?? item.folder,
      label: item.label || "Ember",
      number: tabs?.tab ?? null,
      open: Array.isArray(tabs?.chats) ? new Set([...(tabs.strip ?? []), ...tabs.chats]) : null,
      working: Number.isInteger(working) && working > 0 ? working : 0,
      dirty: Boolean(item.dirty?.length),
      items: item.items ?? [],
    }];
  }).sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity) || a.label.localeCompare(b.label));
}

function attentionFor(tabs) {
  const items = tabs.flatMap((tab) => tab.items.map((item) => ({ ...item, tab: tab.label })));
  const seen = new Set();
  return items.sort((a, b) => b.since - a.since).flatMap((item) => {
    if (seen.has(item.chatId)) return [];
    seen.add(item.chatId);
    return [{ chatId: item.chatId, title: item.title, reason: item.reason, tab: item.tab }];
  });
}

function chatRows() {
  return query(`
    SELECT id, workspace, json_extract(json, '$.title') AS label,
           json_extract(json, '$.cwd') AS cwd,
           json_extract(json, '$.worktree.path') AS worktree,
           json_extract(json, '$.model') AS model,
           json_extract(json, '$.busyPid') AS busyPid,
           json_extract(json, '$.busySince') AS busySince,
           json_extract(json, '$.detail.tool') AS operation,
           json_extract(json, '$.detail.todosDone') AS done,
           json_extract(json, '$.detail.todosTotal') AS total
    FROM chats WHERE hidden = 0 AND archived = 0
    ORDER BY last_activity DESC
  `);
}

const planFiles = new Map();
function trackedPlans(chatById, bonfirePaths, messages) {
  const records = query(`
    SELECT build.key, build.value, EXISTS (
      SELECT 1 FROM json_each(CASE WHEN json_valid(shells.value) THEN shells.value ELSE '[]' END) AS shell
      WHERE json_extract(shell.value, '$.status') = 'running'
    ) AS runningShell
    FROM kv AS build
    LEFT JOIN kv AS shells ON shells.key = 'shells:' || substr(build.key, length('planBuild:') + 1)
    WHERE build.key >= 'planBuild:' AND build.key < 'planBuild;'
  `);
  if (!records) return null;
  const grouped = new Map();
  for (const record of records) {
    const chat = chatById.get(record.key.slice("planBuild:".length));
    const build = json(record.value);
    if (!chat || !build?.uri?.startsWith("file:")) continue;
    let path;
    try { path = fileURLToPath(build.uri); } catch { continue; }
    if (bonfirePaths.has(path)) continue;
    if (!grouped.has(path)) grouped.set(path, { scope: new Set(), all: false, building:false, background:false });
    const entry = grouped.get(path);
    entry.building ||= Boolean(chat.busySince && alive(chat.busyPid));
    entry.background ||= Boolean(record.runningShell) || Boolean(messages.get(chat.id)?.some(item => item.role === "tool" && item.state === "background"));
    if (build.scope?.length) for (const id of build.scope) entry.scope.add(id);
    else entry.all = true;
  }
  for (const path of planFiles.keys()) if (!grouped.has(path)) planFiles.delete(path);
  const plans = [];
  for (const [path, group] of grouped) {
    const fallback = fallbackTitleFromPath(path);
    try {
      const stat = statSync(path);
      let cached = planFiles.get(path);
      if (!cached || cached.mtime !== stat.mtimeMs || cached.size !== stat.size) {
        const parsed = parsePlanFile(readFileSync(path, "utf8"), fallback);
        if (parsed.error) throw new Error("Unreadable plan");
        cached = { mtime: stat.mtimeMs, size: stat.size, label: parsed.title, todos: parsed.todos };
        planFiles.set(path, cached);
      }
      const items = cached.todos.filter(t => group.all || group.scope.has(t.id)).map(t => ({
        id: t.id, label: t.content, state: ({ completed: "Finished", in_progress: "Working", cancelled: "Cancelled" })[t.status] ?? "Queued",
      }));
      plans.push({ id: path, label: cached.label, items, buildMode:group.building ? "building" : group.background ? "background" : "paused", total: items.length, done: items.filter(t => t.state === "Finished").length });
    } catch {
      plans.push({ id: path, label: fallback, items: [], total: 0, done: 0, state: "Plan file unavailable" });
    }
  }
  return plans;
}

function tasksFor(tabs, details, attention, now, messages) {
  const runs = query("SELECT value FROM kv WHERE key >= 'bonfire.run:' AND key < 'bonfire.run;'");
  if (!runs || !details) return null;
  const chatById = new Map(details.map((chat) => [chat.id, chat]));
  const attentionById = new Map(attention.map((item) => [item.chatId, item.reason]));
  const builds = runs.flatMap(({ value }) => {
    const record = json(value);
    const run = json(record?.text);
    if (run?.v !== 2 || run.state !== "running" || !Array.isArray(run.todos)) return [];
    const merged = run.todos.filter((todo) => todo.mergedAt != null || todo.frozen === "merged").length;
    const running = now - record.at < 30_000;
    const items = run.todos.map((todo) => {
      const chat = chatById.get(todo.chatId);
      const needs = attentionById.get(todo.chatId);
      let state = "Started";
      if (todo.mergedAt != null || todo.frozen === "merged") state = "Finished";
      else if (todo.error) state = "Failed";
      else if (todo.stopped) state = "Stopped";
      else if (!todo.chatId) state = "Queued";
      else if (!running) state = "Paused";
      else if (needs && needs !== "finished") state = "Needs attention";
      else if (chat?.busySince && alive(chat.busyPid)) state = "Working";
      return { id: todo.id, label: todo.title, detail: run.planTitle, state };
    });
    return [{
      id: run.id, path: run.planPath, label: run.planTitle,
      detail: merged + " of " + run.todos.length + " merged",
      state: running ? "Running" : "Paused",
      done: merged,
      total: run.todos.length,
      items,
    }];
  });
  const open = new Set(tabs.flatMap((tab) => [...(tab.open ?? [])]));
  const chats = details.filter(({ id, done, total }) => open.has(id) && total > (done ?? 0)).map(({ label, done, total }) => ({
    label, done: done ?? 0, total, state: (done ?? 0) + " / " + total + " done",
  }));
  return { builds, chats, plans: trackedPlans(chatById, new Set(builds.map(build => build.path)), messages) };
}

function usageFor(since) {
  const rows = query(`
    SELECT json_extract(u.json, '$.turn.model') AS label,
           CAST(strftime('%H', json_extract(u.json, '$.turn.ts') / 1000, 'unixepoch', 'localtime') AS integer) AS hour,
           sum(coalesce(json_extract(u.json, '$.turn.input'), 0)) AS input,
           sum(coalesce(json_extract(u.json, '$.turn.output'), 0)) AS output,
           sum(coalesce(json_extract(u.json, '$.turn.cacheRead'), 0)
             + coalesce(json_extract(u.json, '$.turn.write5m'), 0)
             + coalesce(json_extract(u.json, '$.turn.write1h'), 0)) AS cache
    FROM usage_rows u JOIN chats c ON c.id = json_extract(u.json, '$.turn.sessionId')
    WHERE u.kind = 'turn' AND json_extract(u.json, '$.turn.ts') >= ${since}
    GROUP BY label, hour
  `);
  if (!rows) return null;
  const byModel = new Map();
  const hours = Array(24).fill(0);
  for (const row of rows) {
    const label = row.label || "Unknown model";
    const model = byModel.get(label) ?? { label, input: 0, output: 0, cache: 0, total: 0 };
    const total = row.input + row.output + row.cache;
    model.input += row.input;
    model.output += row.output;
    model.cache += row.cache;
    model.total += total;
    byModel.set(label, model);
    if (Number.isInteger(row.hour)) hours[row.hour] += total;
  }
  const models = [...byModel.values()].sort((a, b) => b.total - a.total);
  return { total: models.reduce((sum, model) => sum + model.total, 0), models, hours };
}

let report;
let reportChecked = 0;
let usage = null;
let usageChecked = 0;
let usageDay = 0;
let sources = [];
const rendered = new WeakMap();
function present(items, prefs, cwd) {
  const key = JSON.stringify([cwd, prefs.showMessageTimestamps, prefs.timeFormat, prefs.timeZone]);
  const previous = rendered.get(items);
  if (previous?.key === key) return previous.value;
  const paths = new Map();
  for (const item of items) {
    for (const value of [item.text, item.command, item.result, item.summary]) {
      if (!value) continue;
      for (const span of linkSpans(value)) {
        if (span.kind !== "path" || paths.has(span.ref.path) || paths.size >= 256) continue;
        const path = span.ref.path;
        paths.set(path, pathAttempts(path, { cwd, home: homedir(), platform: process.platform }).some(existsSync));
      }
    }
  }
  const value = {
    paths: [...paths].filter(([, exists]) => exists).map(([path]) => path),
    messages: prefs.showMessageTimestamps ? items.map(item => item.role === "user" && Number.isFinite(Date.parse(item.at))
      ? { ...item, stamp: formatClock(Date.parse(item.at), prefs.timeFormat, prefs.timeZone) } : item) : items,
  };
  rendered.set(items, { key, value });
  return value;
}
function collect() {
  const at = Date.now();
  const midnight = new Date(at);
  midnight.setHours(0, 0, 0, 0);
  if (at - usageChecked >= 60_000 || usageDay !== +midnight) {
    usage = usageFor(+midnight);
    usageChecked = at;
    usageDay = +midnight;
  }
  if (at - reportChecked >= 300_000) {
    reportChecked = at;
    const args = ["--jitless", fileURLToPath(new URL("./usage-report.mjs", import.meta.url)), root];
    const opts = { encoding: "utf8", timeout: 15000 };
    const accept = (error, result) => {
      try {
        if (error) throw error;
        report = JSON.parse(result);
      } catch { console.error("Ember widget: usage dashboard refresh failed."); }
    };
    execFile(process.execPath, args, opts, accept);
  }
  const windowsNow = windows(at);
  const details = chatRows();
  const chatById = new Map((details ?? []).map((item) => [item.id, item]));
  // Ember publishes its running branch chat steps separately from saved chat history.
  const liveSteps = new Map();
  if (details?.some(chat => chat.busySince)) {
    const rows = query(`SELECT r.writer, r.at, json_extract(c.value, '$.id') AS id,
        json_extract(c.value, '$.step') AS step
      FROM branch_rows r, json_each(r.json, '$.chats') c
      WHERE r.kind='branch' AND json_extract(c.value, '$.status')='running'
        AND json_extract(c.value, '$.step') IS NOT NULL ORDER BY r.at`) ?? [];
    for (const row of rows) {
      const chat = chatById.get(row.id);
      if (chat?.busyPid === row.writer && row.at >= chat.busySince) liveSteps.set(row.id, row.step);
    }
  }
  const attention = attentionFor(windowsNow);
  const tabs = windowsNow.map(({ pid, folder, label, number, open, working, dirty }) => {
    const ids = new Set(open ?? []);
    for (const chat of details ?? []) {
      if (chat.busySince && chat.busyPid === pid) ids.add(chat.id);
    }
    const chats = [...ids].flatMap((id) => {
      const chat = chatById.get(id);
      return chat?.label ? [{
        id, label: chat.label, model: chat.model, operation: chat.operation, liveStep: liveSteps.get(id),
        active: Boolean(chat.busySince && alive(chat.busyPid)),
        folders: [chat.cwd, chat.worktree, chat.workspace, folder],
      }] : [];
    }).sort((a, b) => Number(b.active) - Number(a.active));
    return { id: pid, label, number, chats: open?.size ?? null, working, dirty, openChats: chats };
  });
  sources = tabs.flatMap(tab => tab.openChats);
  const messages = transcriptTails(sources);
  const preferences = new Map();
  function prefsFor(folders) {
    const workspace = folders[3];
    const cwd = folders[1] || folders[0] || workspace;
    const key = JSON.stringify([workspace,cwd]);
    if (!preferences.has(key)) preferences.set(key, chatSettings(workspace,cwd));
    return preferences.get(key);
  }
  const state = {
    hasRevision: true,
    chatPrefs: chatSettings(),
    tabs: tabs.map((tab) => ({
      ...tab,
      openChats: tab.openChats.map(({ id, label, model, operation, liveStep, active, folders }) => {
        const prefs = prefsFor(folders);
        const items = messages.get(id) ?? [];
        return { id, label, model, operation, liveStep, active, prefs,
          ...present(items, prefs, folders[1] || folders[0] || folders[3]) };
      }),
    })),
    needs: attention.filter((item) => item.reason !== "finished").length,
    attention: attention.slice(0, 50).map(({ title, reason, tab }) => ({ title, reason, tab })),
    tasks: tasksFor(windowsNow, details, attention, at, messages),
    usage, report,
  };
  return versioned(state, at);
}

function versioned(state, at) {
  const revision = createHash("sha256").update(JSON.stringify(state)).digest("hex");
  return { version: 1, at, revision, ...state };
}

function publish(snapshot) {
  writeSnapshot(output, "window.emberWidgetSnapshot?.(" + JSON.stringify(snapshot) + ");\n");
  writeSnapshot(join(context.directory, "revision.js"), "window.emberRevision?.(" + JSON.stringify(snapshot.revision) + "," + snapshot.at + ");");
}

function writeSnapshot(output, payload) {
  const temporary = join(dirname(output), ".snapshot-" + process.pid + ".tmp");
  try {
    writeFileSync(temporary, payload, { mode: 0o600 });
    renameSync(temporary, output);
  } finally {
    rmSync(temporary, { force: true });
  }
}


let current = collect();
publish(current);
{
  const watchers = new Map();
  let pending;
  function refreshMessages() {
    pending = undefined;
    const tails = transcriptTails(sources);
    const { at, revision, version, ...state } = current;
    for (const tab of state.tabs) {
      for (const chat of tab.openChats) {
        const source = sources.find(entry => entry.id === chat.id);
        const folders = source.folders;
        Object.assign(chat, present(tails.get(chat.id) ?? [], chat.prefs, folders[1] || folders[0] || folders[3]));
      }
    }
    const next = versioned(state, Date.now());
    if (next.revision !== revision) {
      publish(next);
      current = next;
    }
  }
  function schedule() {
    if (!pending) pending = setTimeout(() => {
      try { refreshMessages(); } catch (error) { console.error("Ember transcript refresh:", error.message); }
    }, 300);
  }
  function syncWatchers() {
    const files = new Set(transcriptFiles().values());
    for (const [file, handle] of watchers) {
      if (!files.has(file)) { handle.close(); watchers.delete(file); }
    }
    for (const file of files) {
      if (watchers.has(file)) continue;
      try {
        const handle = watch(file, { persistent: false }, event => {
          if (event === "rename") close();
          schedule();
        });
        function close() { handle.close(); watchers.delete(file); }
        handle.on("error", close);
        watchers.set(file, handle);
      } catch { /* Periodic discovery retries missing or replaced files. */ }
    }
  }
  syncWatchers();
  setInterval(() => {
    try {
      current = collect();
      publish(current);
      syncWatchers();
    } catch (error) { console.error("Ember widget refresh:", error.message); }
  }, tick);
}
