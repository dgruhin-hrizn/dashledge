// Short-lived so the companion never retains the desktop dashboard's per-turn data.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "./shared.mjs";
import { UsageStore } from "./shared.mjs";
import { buildDayDetail, buildDashboard, localClock, rangeStart } from "./shared.mjs";
import { dailySeries, cacheSeries, heatLevels, sparkValues } from "./shared.mjs";
import { fmtTokensSpaced, fmtUsd } from "./shared.mjs";
import { BUILT_IN_PRICES, completePrice } from "./shared.mjs";

const root = process.argv[2];
const at = Date.now();
const db = new DatabaseSync(join(root,"User/globalStorage/ember.ember-agent/ember.db"), { readOnly:true });
let settings = {};
try { settings = parse(readFileSync(join(root,"User/settings.json"),"utf8")) ?? {}; } catch {}
const prices = { ...BUILT_IN_PRICES };
try {
  const state = new DatabaseSync(join(root,"User/globalStorage/state.vscdb"), { readOnly:true });
  const fetched = state.prepare(`SELECT json_extract(value, '$."ember.usagePricing.fetched.v1".prices') AS prices FROM ItemTable WHERE key='ember.ember-agent'`).get();
  Object.assign(prices, JSON.parse(fetched?.prices ?? "{}"));
  state.close();
} catch {}
for (const [model, value] of Object.entries(settings["ember.usageDashboard.prices"] ?? {})) {
  const rates = completePrice(value);
  if (rates) prices[model] = rates;
}
const store = new UsageStore();
const periods = ["7d","14d","month"];
const since = Math.min(...periods.map(range => rangeStart(range, at, localClock, at)));
for (const row of db.prepare("SELECT json_extract(json,'$.turn') AS turn FROM usage_rows WHERE kind='turn' AND json_extract(json,'$.turn.ts') BETWEEN ? AND ?").iterate(since,at)) {
  const turn = JSON.parse(row.turn);
  store.turns.set(turn.key, turn);
}
for (const row of db.prepare("SELECT key, json FROM usage_rows WHERE kind='title'").iterate()) {
  store.titles.set(row.key, JSON.parse(row.json));
}
for (const row of db.prepare("SELECT id, json_extract(json,'$.title') AS title FROM chats").iterate()) {
  if (row.title) store.titles.set(row.id, { title:row.title, custom:true });
}
const latest = db.prepare("SELECT value FROM kv WHERE key GLOB ? ORDER BY key DESC LIMIT 1");
const accounts = settings["ember.accounts.list"] ?? [];
const meters = [];
for (const { id, label } of accounts.some(a => a.id === "main") ? accounts : [{id:"main",label:"Default"}, ...accounts]) {
  const key = id === "main" ? "usage.limits.*" : "usage.accountLimits." + id + ".*";
  const raw = JSON.parse(latest.get(key)?.value ?? "null");
  const point = Array.isArray(raw) ? raw.at(-1) : raw;
  if (point?.windows?.length) meters.push({ label, ...point });
}
const slots = JSON.parse(db.prepare("SELECT value FROM kv WHERE key='usage.slots'").get()?.value ?? "null");
db.close();
const ranges = {};
for (const range of periods) {
  const v = buildDashboard(store, {range}, at, prices, { slots });
  const t = v.totals;
  const tiles = [
    ["Chats",t.sessions.toLocaleString("en-US")], ["Turns",t.turns.toLocaleString("en-US"),"turns"],
    ...["input","output","cacheRead","cacheWrite"].map((k,i)=>[["Input","Output","Cache read","Cache write"][i],fmtTokensSpaced(t.tokens[k]),k]),
    ["Subagent tokens",fmtTokensSpaced(t.subagentTokens)], ["API-equivalent cost",fmtUsd(t.cost,!!t.partial),"cost"]
  ].map(([label,value,key])=>({label,value,points:key ? sparkValues(v.daily,key).map(p=>p.value) : []}));
  ranges[range] = {tiles, daily:dailySeries(v,"tokens"), cost:dailySeries(v,"cost"), heat:heatLevels(v.heatmap,"turns"), cache:cacheSeries(v.daily).share};
}
// Rank all sessions before trimming. A costly chat can fall outside the desktop's token-ranked top 20.
const days = {};
for (const day of new Set(Object.values(ranges).flatMap(range => range.daily.days))) {
  const { sessions } = buildDayDetail(store, {range:"14d"}, day, prices, {sessionLimit:Infinity});
  const projects = new Map();
  const chats = [];
  for (const session of sessions) {
    const tokens = Object.values(session.tokens).reduce((sum,n) => sum+n,0);
    const project = projects.get(session.project) ?? {label:session.project, tokens:0, cost:null, partial:false};
    project.tokens += tokens;
    if (session.cost !== null) project.cost = (project.cost ?? 0) + session.cost;
    project.partial ||= session.cost === null || Boolean(session.partial);
    projects.set(session.project,project);
    chats.push({label:session.title || "Chat " + session.id.slice(0,8), tokens, cost:session.cost, partial:session.partial});
  }
  days[day] = {};
  for (const metric of ["tokens","cost"]) {
    const top = rows => [...rows].filter(row => row[metric] > 0)
      .sort((a,b) => b[metric]-a[metric] || a.label.localeCompare(b.label)).slice(0,3)
      .map(row => ({label:row.label, value:metric === "cost" ? fmtUsd(row.cost,row.partial) : fmtTokensSpaced(row.tokens)}));
    days[day][metric] = {projects:top(projects.values()), chats:top(chats)};
  }
}
console.log(JSON.stringify({at,meters,ranges,days}));
