(() => {
  const el = (id) => document.getElementById(id);
  const cards = el("cards");
  const feed = el("messages");
  const tabs = [...document.querySelectorAll("nav button")];
  const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  const reasons = {
    approval: "Approval", question: "Question", signin: "Sign in", stalled: "Stalled",
    failed: "Failed", interrupted: "Interrupted", limitReset: "Limit reset", finished: "Ready",
  };
  let view = tabs.find(tab => tab.getAttribute("aria-pressed") === "true").dataset.view;
  let snapshot;
  let workspaceId;
  let chatId;
  let follow = true;
  let knownScrollTop = 0;
  let displayedChat;
  let displayedMessages;
  let loading = false;

  function text(tag, value, className) {
    const node = document.createElement(tag);
    node.textContent = value;
    if (className) node.className = className;
    return node;
  }

  function put(id, value) {
    el(id).textContent = value;
  }

  function button(id, enabled) {
    el(id).disabled = !enabled;
  }

  const heat = document.querySelector(".heat");
  let activityMode = "";
  function hasBackground(chat) {
    return chat?.messages?.some(item => item.role === "tool" && item.state === "background") ?? false;
  }

  function isWorking(chat) {
    return Boolean(chat?.active || hasBackground(chat));
  }

  function workingCount(tab) {
    return Math.max(tab.working, tab.openChats.filter(isWorking).length);
  }

  function activityOf(value) {
    let background = false;
    for (const tab of value.tabs) {
      if (tab.working) return "working";
      for (const chat of tab.openChats) {
        if (chat.active) return "working";
        if (hasBackground(chat)) background = true;
      }
    }
    return background ? "background" : "";
  }

  function connection() {
    const status = el("connection");
    const fresh = snapshot && Date.now() - snapshot.at < 30_000;
    document.body.classList.toggle("motion-stale", !fresh);
    heat.hidden = !fresh || !activityMode;
    heat.dataset.mode = activityMode;
    heat.setAttribute("aria-label", activityMode === "working" ? "Ember is working" : "Background tasks running");
    status.dataset.live = String(Boolean(fresh && snapshot.tabs.length));
    status.textContent = !snapshot ? "Collector offline" : !fresh ? "Data stale" : snapshot.tabs.length ? "Live" : "Ember closed";
    put("source", snapshot ? time.format(snapshot.at) : "");
    if (view === "todos" && status.dataset.planFresh !== String(Boolean(fresh))) {
      status.dataset.planFresh = String(Boolean(fresh));
      drawPlans();
    }
  }

  function panel(title, metric) {
    const section = text("section", "", "panel");
    const header = text("header", "", "panel-heading");
    header.append(text("h2", title));
    section.append(header);
    if (metric != null) section.append(text("strong", metric, "metric accent"));
    cards.append(section);
    return { section, header };
  }

  let selectedPlan;
  let planKey;
  function groupFor(state) {
    if (state === "Finished") return "Finished";
    if (state === "Queued") return "Queued";
    if (["Cancelled", "Stopped", "Failed", "Paused", "Needs attention"].includes(state)) return "Attention";
    return "In progress";
  }

  function drawPlans() {
    const live = Array.isArray(snapshot?.tasks?.plans);
    const saved = window.emberSavedPlans;
    const tasks = live ? snapshot.tasks : saved?.tasks ?? snapshot?.tasks;
    const plans = [...(tasks?.builds ?? []), ...(tasks?.plans ?? [])];
    const plan = plans.find(item => (item.id ?? item.label) === selectedPlan) ?? plans.find(item => item.buildMode === "building" || item.state === "Running") ?? plans[0];
    selectedPlan = plan?.id ?? plan?.label;
    const stamp = !live && saved ? " · Saved " + time.format(saved.at) : "";
    const fresh = live && Date.now() - snapshot.at < 30_000;
    el("plans-view").classList.toggle("reduce-motion", !!snapshot?.chatPrefs?.reducedMotion);
    const key = JSON.stringify([plans, selectedPlan, stamp, live, fresh]);
    if (key === planKey) return;
    planKey = key;
    const list = el("plan-list");
    list.parentElement.hidden = plans.length < 2;
    const listTop = list.scrollTop;
    list.replaceChildren();
    for (const item of plans) {
      const entry = text("div", "", "tap-row plan-choice");
      entry.append(text("strong", item.label), text("small", item.done + " / " + item.total + " finished"));
      entry.setAttribute("aria-pressed", String(item === plan));
      entry.addEventListener("click", () => { selectedPlan = item.id ?? item.label; drawPlans(); });
      list.append(entry);
    }
    list.scrollTop = listTop;
    put("plan-title", plan?.label ?? (tasks ? "No active builds" : "Waiting for plan data"));
    const steps = plan?.items ?? [];
    const mode = plan?.buildMode;
    const complete = plan?.total > 0 && plan.done === plan.total;
    const status = complete ? "Finished" : mode === "paused" ? "Paused" :
      mode === "background" ? "Background" : mode === "building" || plan?.state === "Running" ? "Building" : plan?.state;
    el("plan-band").hidden = !plan;
    put("plan-progress", !fresh && plan ? "Last recorded" + stamp : status ?? "Plan");
    put("plan-count", plan?.total ? plan.done + " of " + plan.total + " finished" : "");
    el("plans-view").dataset.building = String(fresh && status === "Building");
    const strip = el("step-strip");
    const rows = el("plan-steps");
    const same = !!plan && rows.dataset.plan === String(selectedPlan);
    const top = rows.scrollTop;
    const anchor = same && [...rows.children].find(row => row.offsetTop + row.offsetHeight > top);
    const offset = anchor ? top - anchor.offsetTop : 0;
    rows.dataset.plan = String(selectedPlan);
    rows.replaceChildren();
    strip.replaceChildren();
    if (!plan) return;
    if (!steps.length) rows.append(text("li", "No steps available", "plan-empty"));
    let focus;
    let restore;
    for (const [index, step] of steps.entries()) {
      const group = groupFor(step.state);
      const segment = text("i", "");
      segment.dataset.group = group;
      strip.append(segment);
      const row = text("li", "", "plan-step");
      row.dataset.group = group;
      row.dataset.state = step.state;
      row.dataset.key = step.id ?? String(index);
      const important = group === "In progress" || group === "Attention";
      const dot = text("span", group === "Finished" ? "✓" : "", "plan-dot");
      dot.setAttribute("aria-hidden", "true");
      const copy = text("div", "", "step-copy");
      const id = /^(t\d+)(?:-|$)/.exec(step.id)?.[1] ?? step.id;
      const label = step.state === "Working" && (mode === "paused" || !fresh) ? "Last in progress" : step.state;
      if (important) copy.append(text("small", [label, id].filter(Boolean).join(" · "), "step-state"));
      else if (id) copy.append(text("span", id, "step-id"));
      copy.append(text("span", step.label, "step-label"));
      row.setAttribute("aria-label", [label, id, step.label].filter(Boolean).join(", "));
      row.append(dot, copy);
      rows.append(row);
      if (important && !focus) focus = row;
      if (anchor && anchor.dataset.key === row.dataset.key) restore = row;
    }
    if (same) rows.scrollTop = restore ? restore.offsetTop + offset : top;
    else if (focus) requestAnimationFrame(() => {
      if (focus.isConnected) rows.scrollTop = Math.max(0, focus.offsetTop - 4);
    });
  }

  let usageRange = "14d";
  let selectedDay;
  let chartMetric = "tokens";
  let displayedReport;
  const palette = ["#d97757","#8fb0d8","#c49bc0","#9db36a","#d9b25f"];
  const ns = "http://www.w3.org/2000/svg";

  function seriesLine(values, color) {
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 100 30");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");
    const peak = Math.max(1, ...values.filter(v => v != null));
    let segment = [];
    function flush() {
      if (segment.length > 1) {
        const line = document.createElementNS(ns, "polyline");
        line.setAttribute("points", segment.map(([x,y]) => x + "," + y).join(" "));
        line.setAttribute("fill", "none");
        line.setAttribute("stroke", color);
        line.setAttribute("vector-effect", "non-scaling-stroke");
        line.setAttribute("stroke-width", "2");
        line.setAttribute("stroke-linejoin", "round");
        svg.append(line);
      }
      segment = [];
    }
    values.forEach((value,i) => {
      if (value == null) { flush(); return; }
      segment.push([1 + 98*i/Math.max(1,values.length-1),28 - 26*value/peak]);
    });
    flush();
    return svg;
  }

  // One segmented control, as on Ember's own Usage page: a joined row of choices.
  function segmented(label, options, current, choose) {
    const group = text("div", "", "ud-segmented");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", label);
    for (const [key, name, spoken] of options) {
      const choice = text("button", name);
      choice.type = "button";
      if (spoken) choice.setAttribute("aria-label", spoken);
      choice.setAttribute("aria-pressed", String(key === current));
      choice.onclick = () => { if (key !== current) choose(key); };
      group.append(choice);
    }
    return group;
  }

  function usagePanel(title, name, note) {
    const section = text("section", "", "panel ud-" + name);
    const header = text("header", "", "panel-heading");
    header.append(text("h2", title));
    if (note) header.append(text("small", note, "ud-note"));
    section.append(header);
    return section;
  }

  // Green with room to spare, amber as a window tightens, red near its end.
  function capacityColor(remaining) {
    const low = remaining <= 30;
    const weight = Math.max(0, Math.min(1, low ? (remaining - 10) / 20 : (remaining - 30) / 40)) * 100;
    return low ? "color-mix(in srgb, #e07a68, #d9b25f " + weight + "%)" : "color-mix(in srgb, #d9b25f, #9db36a " + weight + "%)";
  }

  function capacityBar(remaining, label) {
    const bar = text("progress", "", "ud-capacity");
    bar.max = 100;
    bar.value = remaining;
    bar.setAttribute("aria-label", label);
    return bar;
  }

  const resetFormat = { weekday: "short", hour: "numeric", minute: "2-digit" };

  // The primary reading: the plan window with the least room left, across every account.
  function drawHeadroom(report) {
    const panel = usagePanel("Plan headroom", "headroom");
    const now = Date.now();
    const accounts = report.meters.map(account => ({
      label: account.label,
      all: account.windows,
      windows: new Map(account.windows
        .filter(w => Number.isFinite(w.percent) && !(Date.parse(w.resetsAt) <= now))
        .map(w => [w.id, { ...w, remaining: Math.max(0, Math.min(100, 100 - w.percent)) }])),
    })).filter(account => account.windows.size);
    const columns = new Map([["five_hour","5-hour"], ["seven_day","Weekly"], ["model:fable","Fable"]]);
    for (const account of accounts) for (const w of account.windows.values()) if (!columns.has(w.id)) columns.set(w.id, w.label);
    let tightest;
    for (const account of accounts) {
      for (const w of account.windows.values()) {
        const reset = Date.parse(w.resetsAt);
        const better = !tightest || w.remaining < tightest.w.remaining ||
          (w.remaining === tightest.w.remaining && Number.isFinite(reset) && !(Date.parse(tightest.w.resetsAt) <= reset));
        if (better) tightest = { account, w };
      }
    }
    const hero = text("div", "", "ud-hero");
    if (tightest) {
      const { account, w } = tightest;
      const name = columns.get(w.id) ?? w.label;
      hero.style.setProperty("--capacity-color", capacityColor(w.remaining));
      hero.dataset.low = String(w.remaining <= 30);
      const reading = text("p", "", "ud-primary");
      reading.append(text("strong", String(Math.round(w.remaining))), text("span", "% left", "ud-primary-unit"));
      reading.setAttribute("aria-label", Math.round(w.remaining) + "% left in " + account.label + "'s " + name + " window");
      const reset = Date.parse(w.resetsAt);
      const what = text("p", "", "ud-hero-what");
      what.append(text("b", name), document.createTextNode(accounts.length > 1 ? " · " + account.label : ""));
      hero.append(reading, capacityBar(w.remaining, account.label + " · " + name + " remaining"), what);
      if (Number.isFinite(reset)) hero.append(text("p", "Resets " + new Date(reset).toLocaleString(undefined, resetFormat), "ud-hero-reset"));
    } else {
      const reading = text("p", "", "ud-primary ud-primary-empty");
      reading.append(text("strong", "—"));
      hero.append(reading, text("p", "No current plan readings. Limits appear once Ember reads an account.", "ud-hero-reset"));
    }
    panel.append(hero);
    if (!accounts.length) return panel;
    const list = text("div", "", "ud-accounts");
    for (const account of accounts) {
      const row = text("div", "", "ud-account");
      row.append(text("strong", account.label, "ud-account-name"));
      const gauges = text("div", "", "ud-gauges");
      for (const [id, name] of columns) {
        const w = account.windows.get(id);
        const meter = text("div", "", "ud-gauge");
        if (!w) {
          const unlimited = id === "five_hour" && !account.all.some(entry => entry.id === id);
          const value = text("b", unlimited ? "∞" : "—", unlimited ? "ud-unlimited" : "ud-unavailable");
          value.setAttribute("aria-label", unlimited ? "No 5-hour limit" : name + " reading unavailable");
          meter.append(text("span", name), value);
        } else {
          meter.style.setProperty("--capacity-color", capacityColor(w.remaining));
          if (tightest?.w === w) meter.dataset.tightest = "true";
          meter.append(text("span", name), text("b", Math.round(w.remaining) + "%"), capacityBar(w.remaining, account.label + " · " + name + " remaining"));
        }
        gauges.append(meter);
      }
      row.append(gauges);
      list.append(row);
    }
    panel.append(list);
    return panel;
  }

  function drawOverview() {
    const report = snapshot.report ?? window.emberUsageBootstrap;
    if (!report) {
      const waiting = usagePanel("Usage", "waiting");
      waiting.append(text("p", "Waiting for Ember usage history.", "empty"));
      cards.append(waiting);
      return;
    }
    displayedReport = report.at;
    if (!report.ranges[usageRange]) usageRange = report.ranges["14d"] ? "14d" : Object.keys(report.ranges)[0];
    const data = report.ranges[usageRange];
    const title = text("header", "", "ud-title");
    const heading = text("div", "", "ud-heading");
    const timestamp = new Date(report.at);
    const today = timestamp.toDateString() === new Date().toDateString();
    const updated = (today ? "" : timestamp.toLocaleDateString(undefined,{month:"short",day:"numeric"}) + ", ") + time.format(timestamp);
    heading.append(text("small", "All accounts · " + updated, "ud-eyebrow"), text("h2", "Usage"));
    const ranges = [["7d","7 days"],["14d","14 days"],["month","Month","Month to date"]].filter(([key]) => report.ranges[key]);
    title.append(heading, segmented("Range", ranges, usageRange, key => { usageRange = key; selectedDay = undefined; drawBoard("range"); }));
    cards.append(title, drawHeadroom(report));
    const tiles = text("div", "", "ud-tiles");
    for (const t of data.tiles) {
      const tile = text("div", "", "ud-stat");
      const shortLabel = {"API-equivalent cost":"API cost", "Subagent tokens":"Subagent"}[t.label] ?? t.label;
      tile.setAttribute("role", "group");
      tile.setAttribute("aria-label", t.label + " " + t.value);
      tile.append(text("small", shortLabel), text("strong", t.value));
      if (t.points.length) tile.append(seriesLine(t.points, "#e3936f"));
      else if (t.label === "Subagent tokens") tile.append(text("span", "included above", "ud-stat-note"));
      tiles.append(tile);
    }
    cards.append(tiles, drawDaily(data, report.days), drawHeat(data));
  }

  function drawHeat(data) {
    const heat = usagePanel("Hour × weekday", "heat", "Turns");
    const grid = text("div", "", "ud-grid");
    const levels = new Map(data.heat.data.map(([h,d,v]) => [24*d+h, v]));
    const weekdays = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
    for (const d of [0,1,2,3,4,5,6]) {
      const label = text("small", weekdays[d].slice(0,3));
      label.title = weekdays[d];
      grid.append(label);
      for (let h = 0; h < 24; h++) {
        const cell = text("i", "");
        cell.dataset.level = levels.get(24*d+h) ?? 0;
        grid.append(cell);
      }
    }
    const clock = text("div", "", "ud-clock");
    for (const hour of ["12 am","6 am","Noon","6 pm"]) clock.append(text("span", hour));
    grid.append(clock);
    const key = text("div", "", "ud-heat-key");
    key.setAttribute("aria-hidden", "true");
    key.append(text("span", "Fewer"));
    for (let level = 0; level < 5; level++) { const swatch = text("i", ""); swatch.dataset.level = level; key.append(swatch); }
    key.append(text("span", "More"));
    heat.append(grid, key);
    return heat;
  }

  // Label every nth day, counted back from today, with n as small as the column width allows.
  function thinTicks(axis) {
    const ticks = [...axis.children];
    const column = axis.clientWidth / Math.max(1, ticks.length);
    if (!column) return;
    const gap = parseFloat(getComputedStyle(axis).fontSize);
    const widest = Math.max(...ticks.map(tick => tick.offsetWidth));
    const step = Math.max(1, Math.ceil((widest + gap) / column));
    const today = ticks.at(-1);
    for (const tick of ticks) tick.hidden = tick !== today && (tick.dataset.fromEnd % step !== 0 ||
      tick.getBoundingClientRect().right + gap > today.getBoundingClientRect().left);
  }

  // A round top for the y-axis so its ticks read as plain numbers.
  function niceMax(value) {
    if (!(value > 0)) return 1;
    const power = 10 ** Math.floor(Math.log10(value));
    return power * ([1, 1.2, 1.6, 2, 3, 4, 5, 6, 8, 10].find(step => step * power >= value));
  }

  function drawDaily(data, dayDetails) {
    const detail = dayDetails?.[selectedDay]?.[chartMetric];
    const showingDay = detail && data.daily.days.includes(selectedDay);
    if (!showingDay) selectedDay = undefined;
    const dateLabel = day => new Date(day + "T12:00:00").toLocaleDateString(undefined,{month:"short",day:"numeric"});
    const daily = usagePanel(showingDay ? new Date(selectedDay + "T12:00:00").toLocaleDateString(undefined,{weekday:"long",month:"short",day:"numeric"}) : "Daily usage", "daily");
    const header = daily.querySelector("header");
    function updateDaily() {
      const next = drawDaily(data, dayDetails);
      next.classList.add("ud-reveal");
      daily.replaceWith(next);
    }
    if (showingDay) {
      const back = text("button", "‹ All days", "ud-back");
      back.type = "button";
      back.setAttribute("aria-label", "Back to the daily usage chart");
      back.onclick = () => { selectedDay = undefined; updateDaily(); };
      header.prepend(back);
    }
    const chart = chartMetric === "cost" ? data.cost : data.daily;
    const money = chartMetric === "cost" ? "$" : "";
    const totals = chart.days.map((_,i) => chart.series.reduce((sum,s) => sum + s.values[i], 0));
    const peak = Math.max(0, ...totals);
    const peakIndex = peak > 0 ? totals.indexOf(peak) : -1;
    if (!showingDay && peakIndex >= 0) header.append(text("small", "Peak " + money + compact.format(peak) + " · " + dateLabel(chart.days[peakIndex]), "ud-note"));
    header.append(segmented("Measure", [["tokens","Tokens"],["cost","Cost","API-equivalent cost"]], chartMetric, key => { chartMetric = key; updateDaily(); }));
    if (showingDay) {
      const lists = text("div", "", "ud-rankings");
      for (const [label, rows] of [["Top projects", detail.projects], ["Top chats", detail.chats]]) {
        const section = text("section", "");
        section.append(text("h3", label));
        for (const row of rows) {
          const line = text("div", "", "ud-rank");
          line.append(text("span", row.label), text("b", row.value));
          section.append(line);
        }
        if (!rows.length) section.append(text("p", chartMetric === "cost" ? "No priced usage" : "No usage", "empty"));
        lists.append(section);
      }
      daily.append(lists);
      return daily;
    }
    const legend = text("div", "", "ud-key");
    const ranked = chart.series.map(s => ({ ...s, total: s.values.reduce((a,b) => a+b, 0) }))
      .filter(s => s.total > 0).sort((a,b) => b.total - a.total);
    const series = ranked.length > 3 ? ranked.slice(0,2) : ranked.slice();
    if (ranked.length > 3) {
      const rest = ranked.slice(2);
      series.push({ label: "Other", detail: rest.map(s => s.label).join(", "),
        values: chart.days.map((_,i) => rest.reduce((sum,s) => sum + s.values[i], 0)) });
    }
    for (const [index, s] of series.entries()) {
      s.color = s.detail ? "#8d8a82" : palette[index];
      const label = text("span", s.label.split("/").pop());
      label.title = s.detail ?? s.label;
      label.style.setProperty("--series", s.color);
      legend.append(label);
    }
    const max = niceMax(peak);
    const frame = text("div", "", "ud-plot-frame");
    const scale = text("div", "", "ud-scale");
    scale.setAttribute("aria-hidden", "true");
    for (const fraction of [1, .5, 0]) scale.append(text("span", fraction ? money + compact.format(max * fraction) : "0"));
    const plot = text("div", "", "ud-columns");
    chart.days.forEach((day, i) => {
      const col = text(dayDetails?.[day] ? "button" : "div", "", "ud-column");
      col.title = dateLabel(day) + " · " + money + compact.format(totals[i]);
      if (dayDetails?.[day]) {
        col.type = "button";
        col.setAttribute("aria-label", dateLabel(day) + ", " + money + compact.format(totals[i]) + ". Show its projects and chats");
        col.onclick = () => { selectedDay = day; updateDaily(); };
      }
      if (i === peakIndex) col.dataset.peak = "true";
      const stack = text("span", "", "ud-stack");
      stack.setAttribute("aria-hidden", "true");
      stack.style.setProperty("--delay", Math.round(180 * i / Math.max(1, chart.days.length - 1)) + "ms");
      for (const s of series) {
        const rect = text("i", "");
        rect.style.height = 100 * s.values[i] / max + "%";
        rect.style.background = s.color;
        stack.append(rect);
      }
      col.append(stack);
      plot.append(col);
    });
    const axis = text("div", "", "ud-x");
    axis.setAttribute("aria-hidden", "true");
    chart.days.forEach((day, i) => {
      const tick = text("span", i === chart.days.length - 1 ? "Today" : dateLabel(day));
      tick.style.gridColumn = String(i + 1);
      tick.dataset.fromEnd = chart.days.length - 1 - i;
      axis.append(tick);
    });
    daily.style.setProperty("--day-count", Math.max(1, chart.days.length));
    frame.append(scale, plot, axis);
    daily.append(legend, frame);
    requestAnimationFrame(() => thinTicks(axis));
    return daily;
  }

  function drawBoard(motion = "") {
    if (view === "todos") { drawPlans(); return; }
    cards.dataset.layout = view;
    cards.dataset.motion = motion;
    cards.replaceChildren();
    if (snapshot) drawOverview();
    else panel("Usage").section.append(text("p","Waiting for the local Ember collector.","empty"));
  }

  function workspaceList() {
    return snapshot?.tabs.map((tab, index) => ({ ...tab, id: tab.id ?? index, openChats: tab.openChats.map((chat, pos) => ({ ...chat, id: chat.id ?? pos })) })) ?? [];
  }

  function selection() {
    const workspaces = workspaceList();
    const workspace = workspaces.find((item) => item.id === workspaceId) ?? workspaces.find((item) => item.openChats.some(isWorking)) ?? workspaces[0];
    const chats = workspace?.openChats ?? [];
    const chat = chats.find((item) => item.id === chatId) ?? chats.find(isWorking) ?? chats[0];
    return { workspaces, workspace, chats, chat };
  }

  const openCards = new Map();
  const exploration = new Set(["Read", "NotebookRead", "Grep", "Glob", "LS", "WebFetch", "WebSearch",
    "mcp__ember__codebase_search", "mcp__ember__search_conversations"]);
  const running = (tool) => tool.state === "running" || tool.state === "background";
  const subagent = (tool) => tool.name === "Agent" || tool.name === "Task";

  function foldTools(items, prefs, active) {
    const result = [];
    let start = 0;
    function turn(end, finished) {
      const entries = items.slice(start, end);
      start = end;
      const last = entries.at(-1);
      if (prefs.foldTurns && finished && last?.role === "assistant" && entries.some((item) => item.role === "tool" && !running(item))) {
        const work = entries.slice(0, -1);
        if (!work.some((item) => item.role === "tool" && running(item))) {
          result.push({ group: "Turn activity", entries: work, id: "turn:" + work[0].id }, last);
          return;
        }
      }
      result.push(...groupCalls(entries, prefs));
    }
    for (let i = 0; i < items.length; i++) {
      if (items[i].role !== "user") continue;
      turn(i, true);
      result.push(items[i]);
      start = i + 1;
    }
    turn(items.length, !active);
    return result;
  }

  function groupCalls(entries, prefs) {
    if (prefs.grouping === "off") return entries;
    const canGroup = (item) => item?.role === "tool" && item.state === "ran" && !subagent(item) &&
      (prefs.grouping === "all" || exploration.has(item.name));
    const groups = [];
    for (let i = 0; i < entries.length;) {
      const entry = entries[i++];
      if (!canGroup(entry)) {
        groups.push(entry);
        continue;
      }
      const run = [entry];
      while (i < entries.length) {
        if (canGroup(entries[i])) run.push(entries[i++]);
        else if (prefs.narration && (entries[i].role === "thinking" || entries[i].role === "assistant" && entries[i].text.length < 220) && canGroup(entries[i + 1])) run.push(entries[i++]);
        else break;
      }
      groups.push(run.length > 1 ? { group: run.every((item) => item.role !== "tool" || exploration.has(item.name)) ? "Explored" : "Tool activity", entries: run, id: "run:" + entry.id } : entry);
    }
    return groups;
  }

  // Lucide glyphs used by Ember’s ToolIcon. Only local symbol IDs enter the SVG.
  const glyphNames = {
  "Read": "FileText",
  "Edit": "Pencil",
  "MultiEdit": "Pencil",
  "NotebookEdit": "Pencil",
  "Write": "FilePlus",
  "Bash": "SquareTerminal",
  "Git": "GitCommitHorizontal",
  "GitHub": "GitPullRequest",
  "Blocked": "ShieldAlert",
  "BashOutput": "SquareTerminal",
  "Grep": "TextSearch",
  "Glob": "FolderSearch",
  "LS": "Folder",
  "WebFetch": "Globe",
  "WebSearch": "Search",
  "Task": "Bot",
  "Agent": "Bot",
  "TodoWrite": "ListChecks",
  "TaskCreate": "ListChecks",
  "TaskUpdate": "ListChecks",
  "TaskList": "ListChecks",
  "TaskGet": "ListChecks",
  "Skill": "Sparkles",
  "AskUserQuestion": "MessagesSquare",
  "ListMcpResourcesTool": "Network",
  "ReadMcpResourceTool": "Network",
  "mcp__ember__codebase_search": "Search",
  "mcp__ember__diagnostics": "CircleAlert",
  "mcp__ember__open_editors": "Files",
  "mcp__ember__terminal_output": "SquareTerminal",
  "mcp__ember__agent_blame": "History",
  "mcp__ember__search_conversations": "MessagesSquare",
  "mcp__ember__browser_snapshot": "ScrollText",
  "mcp__ember__browser_screenshot": "Camera",
  "mcp__ember__browser_console": "ScrollText",
  "mcp__ember__browser_network": "Network",
  "mcp__ember__browser_navigate": "Globe",
  "mcp__ember__browser_click": "MousePointerClick",
  "mcp__ember__browser_type": "Keyboard",
  "mcp__ember__browser_back": "ArrowLeft",
  "PowerShell": "SquareTerminal",
  "default": "Wrench",
  "thought": "Brain",
  "group": "ListTree",
  "failure": "X"
};
  function toolIcon(name) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    const use = document.createElementNS(ns, "use");
    use.setAttribute("href", "#tool-" + (Object.hasOwn(glyphNames, name) ? glyphNames[name] : glyphNames.default));
    svg.append(use);
    return svg;
  }

  function disclosure(key, title, body, expanded, mark, state, detail) {
    const card = text("article", "", "tool-card");
    const trigger = text("div", "", "tool-heading tap-row");
    const label = text("span", title, "tool-title");
    const icon = text("span", "", "tool-icon");
    icon.append(toolIcon(state === "failed" ? "failure" : mark));
    icon.setAttribute("aria-hidden", "true");
    if (mark === "thought") card.classList.add("thinking-row");
    trigger.append(icon, label);
    if (detail) {
      label.classList.add("tool-verb");
      trigger.append(text("span", detail, "tool-object"));
    }
    if (state) {
      trigger.dataset.state = state;
      if (state === "background") trigger.append(text("span", "In background", "tool-badge"));
      if (state === "failed") trigger.append(text("span", "Failed", "tool-badge"));
    }
    trigger.append(text("span", "›", "tool-chevron"));
    const set = (open) => {
      trigger.setAttribute("aria-expanded", String(open));
      body.hidden = !open;
      if (open) measurePreviews();
    };
    set(openCards.get(key) ?? expanded);
    trigger.addEventListener("click", () => {
      follow = false;
      const open = body.hidden;
      openCards.set(key, open);
      set(open);
      updateFollow();
    });
    card.append(trigger, body);
    return card;
  }

  // Measure after layout so wrapped lines and nested, newly opened groups count.
  let previewFrame = 0;
  function measurePreviews() {
    if (previewFrame) return;
    previewFrame = requestAnimationFrame(() => {
      previewFrame = 0;
      for (const box of feed.querySelectorAll(".tool-preview")) {
        if (box.clientHeight) box.nextElementSibling.hidden = !box.classList.contains("full-output") && box.scrollHeight <= box.clientHeight + 1;
      }
      if (follow) moveFeed(feed.scrollHeight);
    });
  }
  new ResizeObserver(measurePreviews).observe(feed);

  function renderItem(item, prefs) {
    if (item.group) {
      const details = text("div", "", "tool-group-body");
      details.append(...item.entries.map((entry) => renderItem(entry, prefs)));
      const count = item.entries.filter((entry) => entry.role === "tool").length;
      return disclosure(item.id, item.group + " · " + count + (count === 1 ? " call" : " calls"), details, false, "group");
    }
    if (item.role === "thinking") {
      const body = text("div", item.text, "thought-body");
      const title = Number.isFinite(item.ms) ? "Thought for " + Math.max(1, Math.round(item.ms / 1000)) + "s" : "Thought";
      return disclosure(item.id, title, body, prefs.expand?.thinking, "thought");
    }
    if (item.role === "tool") {
      const body = text("div", "", "tool-body");
      if (item.command) body.append(text("pre", "$ " + item.command, "tool-command"));
      if (item.diff) {
        for (const [className, value, sign] of [["removed", item.diff.oldText, "− "], ["added", item.diff.newText, "+ "]]) {
          if (value) body.append(text("pre", value.split("\n").map((line) => sign + line).join("\n"), "tool-diff " + className));
        }
      }
      if (item.result) body.append(text("pre", item.result, "tool-result"));
      if (!body.childNodes.length) body.append(text("p", running(item) ? "Waiting for output" : "No text output", "empty"));
      const content = text("div", "", "tool-preview");
      content.append(...body.childNodes);
      const key = "height:" + item.id;
      const toggle = text("div", "", "tool-expand tap-row");
      const setHeight = open => {
        content.classList.toggle("full-output", open);
        toggle.textContent = open ? "Collapse" : "Expand";
        toggle.setAttribute("aria-expanded", String(open));
      };
      setHeight(openCards.get(key) === true);
      toggle.hidden = true;
      toggle.onclick = () => {
        follow = false;
        const open = !content.classList.contains("full-output");
        openCards.set(key, open);
        setHeight(open);
        updateFollow();
      };
      body.append(content, toggle);
      const detail = [item.summary, item.lines ? "· " + item.lines + " lines" : ""].filter(Boolean).join(" ");
      return disclosure(item.id, item.verb, body, item.state === "failed" || (subagent(item) ? prefs.expand?.subagents : prefs.expand?.tools), item.name, item.state, detail);
    }
    const article = text("article", "", "message");
    article.dataset.role = item.role;
    article.append(window.emberMarkdown(item.text));
    if (item.role === "user" && prefs.showMessageTimestamps && Number.isFinite(Date.parse(item.at))) {
      article.append(text("time", item.stamp ?? time.format(Date.parse(item.at)), "message-time"));
    }
    return article;
  }

  let taskSignature;
  function drawTasks(chat, messages) {
    const tools = messages.filter(item => item.role === "tool" && running(item));
    const groups = [
      ["Active", tools.filter(item => item.state === "running" && chat?.active)],
      ["Background", tools.filter(item => item.state === "background")],
    ];
    if (chat?.active && chat.operation && !groups[0][1].length) {
      groups[0][1].push({ summary: chat.operation });
    }
    const signature = JSON.stringify([chat?.id, groups]);
    if (signature === taskSignature) return;
    taskSignature = signature;
    const list = el("task-list");
    const fragment = document.createDocumentFragment();
    for (const [heading, rows] of groups) {
      if (!rows.length) continue;
      const group = text("section", "", "task-group");
      const header = text("h3", heading);
      const noun = rows.every(item => item.name === "Bash") ? "command" : "task";
      header.append(text("span", rows.length + " " + noun + (rows.length === 1 ? "" : "s")));
      group.append(header);
      for (const item of rows) {
        const row = text("div", "", "task-line");
        row.dataset.kind = heading;
        row.append(text("code", (item.command || item.summary || item.name).trim().split("\n")[0]));
        const note = item.result?.trim().split("\n").filter(Boolean).at(-1);
        // A launch acknowledgement is metadata, not command output.
        const preview = item.background || /background with ID|will be notified|Session cwd/i.test(note ?? "") ? "" : note;
        row.append(text("span", preview || (item.command ? item.summary : "") || "", "task-note"));
        const age = text("time", "");
        const start = Date.parse(item.at);
        if (Number.isFinite(start)) age.dataset.start = start;
        row.append(age);
        group.append(row);
      }
      fragment.append(group);
    }
    el("activity-now").hidden = !fragment.childElementCount;
    list.replaceChildren(fragment);
    updateTaskTimes();
  }

  function updateTaskTimes() {
    if (view !== "tabs" || !snapshot) return;
    for (const node of el("task-list").querySelectorAll("time[data-start]")) {
      const seconds = Math.max(0, Math.floor((snapshot.at - Number(node.dataset.start)) / 1000));
      const minutes = Math.floor(seconds / 60);
      const value = minutes >= 60 ? Math.floor(minutes / 60) + "h " + minutes % 60 + "m" :
        minutes ? minutes + "m " + seconds % 60 + "s" : seconds + "s";
      if (value !== node.textContent) node.textContent = value;
    }
  }

  function colorReferences(item, paths) {
    for (const container of item.querySelectorAll(".markdown, .tool-result, .tool-command, .tool-object, .thought-body")) {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const node of nodes) {
        if (node.parentElement.closest(".md-link")) continue;
        const value = node.data;
        const spans = EmberReferences.linkSpans(value).filter(span => span.kind === "url" || paths.has(span.ref?.path));
        if (!spans.length) continue;
        const parts = document.createDocumentFragment();
        let start = 0;
        for (const span of spans) {
          parts.append(value.slice(start, span.start), text("span", value.slice(span.start, span.end), "chat-reference"));
          start = span.end;
        }
        parts.append(value.slice(start));
        node.replaceWith(parts);
      }
    }
  }

  function transcript(chat) {
    const messages = chat?.messages ?? [];
    const prefs = chat?.prefs ?? snapshot?.chatPrefs ?? {};
    el("chat-view").classList.toggle("reduce-motion", !!prefs.reducedMotion);
    el("chat-view").style.setProperty("--chat-mono", prefs.fontFamily || '"JetBrains Mono", Menlo, monospace');
    const next = JSON.stringify([messages, chat?.paths, prefs, chat?.active, chat?.liveStep]);
    const newChat = displayedChat !== chat?.id;
    if (newChat) {
      follow = true;
      openCards.clear();
    }
    if (newChat || next !== displayedMessages) {
      const wasTop = feed.scrollTop;
      const reading = [...feed.children].find((item) => item.offsetTop + item.offsetHeight > wasTop);
      const readingKey = reading?.dataset.item;
      const readingOffset = reading ? wasTop - reading.offsetTop : 0;
      feed.replaceChildren();
      feed.style.setProperty("--chat-scale", prefs.textSize ?? 1);
      feed.style.maxWidth = prefs.maxWidth ? prefs.maxWidth + "px" : "";
      const paths = new Set(chat?.paths);
      for (const [index, message] of foldTools(messages, prefs, chat?.active).entries()) {
        const item = renderItem(message, prefs);
        colorReferences(item, paths);
        item.dataset.item = message.id ?? String(index);
        feed.append(item);
      }
      measurePreviews();
      if (!messages.length) feed.append(text("p", chat ? "Waiting for recorded messages." : "Choose an open chat to follow.", "empty"));
      const anchored = readingKey && [...feed.children].find((item) => item.dataset.item === readingKey);
      moveFeed(follow ? feed.scrollHeight : anchored ? anchored.offsetTop + readingOffset : wasTop);
      displayedChat = chat?.id;
      displayedMessages = next;
    }
    const line = el("working-line");
    const notice = snapshot?.attention?.find(entry => entry.title === chat?.label && entry.tab === selection().workspace?.label);
    const waiting = notice && ["approval","question","signin","stalled"].includes(notice.reason);
    const mode = chat?.active ? (waiting ? "waiting" : "working") : hasBackground(chat) ? "background" : "";
    line.hidden = !mode;
    line.dataset.mode = mode;
    const currentTool = messages.findLast(item => item.role === "tool" && item.state === "running");
    const words = mode === "background" ? "Working in the background" : mode === "waiting" ? reasons[notice.reason] :
      chat?.liveStep || (currentTool && [currentTool.verb,currentTool.summary].filter(Boolean).join(" ")) || "Working…";
    const label = line.querySelector(".working-words");
    if (mode && label.textContent !== words) {
      label.textContent = words;
      for (const layer of line.querySelectorAll(".shimmer > span")) layer.dataset.text = words;
    }
    const status = isWorking(chat) ? "Working" : chat ? "Idle" : "";
    put("transcript-title", chat?.label ?? "Transcript");
    put("transcript-status", status);
    el("transcript-status").dataset.active = String(isWorking(chat));
    drawTasks(chat, messages);
    updateFollow();
  }

  // Rendering and returning to live move the feed without changing its follow state.
  function moveFeed(top) {
    feed.scrollTop = top;
    knownScrollTop = feed.scrollTop;
  }

  feed.addEventListener("scroll", () => {
    const top = feed.scrollTop;
    if (top === knownScrollTop || !feed.clientHeight) return;
    knownScrollTop = top;
    follow = feed.scrollHeight - feed.clientHeight - top <= 8;
    updateFollow();
  });

  function updateFollow() {
    el("latest").hidden = follow;
    button("latest", !follow);
  }

  function drawChat() {
    const { workspaces, workspace, chats, chat } = selection();
    workspaceId = workspace?.id;
    chatId = chat?.id;
    const list = el("workspace-list");
    const groups = new Map([...list.children].map(node => [node.itemId, node]));
    for (const [index, tab] of workspaces.entries()) {
      let group = groups.get(tab.id);
      if (!group) {
        group = text("section", "", "history-group");
        group.itemId = tab.id;
        const header = text("div", "", "history-header tap-row");
        header.append(text("i", ""), text("strong", ""), text("span", "", "history-count"));
        header.onclick = () => {
          if (workspaceId === tab.id) return;
          workspaceId = tab.id;
          chatId = undefined;
          drawChat();
          header.scrollIntoView({block:"nearest"});
        };
        group.append(header, text("div", "", "history-chats"));
      }
      groups.delete(tab.id);
      if (list.children[index] !== group) list.insertBefore(group, list.children[index] ?? null);
      const [header, rows] = group.children;
      const here = tab.id === workspaceId;
      const parts = tab.label.split(" / ");
      const branch = parts.at(-1);
      const repo = parts.slice(0,-1).join(" / ");
      const label = [branch,repo].filter(Boolean).join("\n");
      if (header.children[1].textContent !== label) header.children[1].textContent = label;
      const count = String(tab.openChats.length);
      if (header.lastChild.textContent !== count) header.lastChild.textContent = count;
      header.dataset.working = String(tab.openChats.some(isWorking));
      header.setAttribute("aria-pressed",String(here));
      group.classList.toggle("is-here",here);
      rows.hidden = !here;
      if (!here) continue;
      const ranked = chats.map(item => {
        const notice = snapshot?.attention.find(entry => entry.title === item.label && entry.tab === tab.label);
        const rank = notice && notice.reason !== "finished" ? 0 : isWorking(item) ? 1 : notice ? 2 : 3;
        const detail = rank === 0 ? reasons[notice.reason] : rank === 1 ? item.liveStep || (item.active ? "Working" : "In background") : rank === 2 ? "Ready" : "";
        return {id:item.id,label:item.label,rank,detail};
      }).sort((a,b) => a.rank-b.rank);
      if (!touchingChats || !rows.children.length) drawRows(rows,ranked,chatId,id => { chatId = id; });
    }
    for (const group of groups.values()) group.remove();
    transcript(chat);
  }

  let touchingChats = false;
  const chatList = el("workspace-list");
  chatList.addEventListener("touchstart", () => { touchingChats = true; }, { passive: true });
  for (const event of ["touchend", "touchcancel"]) {
    chatList.addEventListener(event, () => {
      touchingChats = false;
      // The next live render can reorder rows after the tap has resolved.
    }, { passive: true });
  }

  function drawRows(list, items, selected, select) {
    // Preserve touch targets and scroll position while live snapshots arrive.
    const existing = new Map([...list.children].map((row) => [row.itemId, row]));
    for (const [index, item] of items.entries()) {
      let row = existing.get(item.id);
      if (!row) {
        row = document.createElement("div");
        row.className = "tap-row";
        row.itemId = item.id;
        row.append(text("strong", ""));
        row.append(text("small", ""));
        row.addEventListener("click", () => {
          if (row.getAttribute("aria-pressed") === "true") return;
          select(row.itemId);
          drawChat();
        });
      }
      existing.delete(item.id);
      if (row.firstChild.textContent !== item.label) row.firstChild.textContent = item.label;
      row.dataset.rank = item.rank;
      const detail = item.detail ?? item.status ?? "";
      if (row.lastChild.textContent !== detail) row.lastChild.textContent = detail;
      row.lastChild.hidden = !detail;
      row.setAttribute("aria-pressed", String(item.id === selected));
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
    }
    for (const row of existing.values()) row.remove();
  }

  function draw(motion = "") {
    connection();
    const chats = view === "tabs";
    el("plans-view").hidden = view !== "todos";
    el("board").hidden = chats || view === "todos";
    el("chat-view").hidden = !chats;
    if (chats) {
      drawChat();
      if (follow) moveFeed(feed.scrollHeight);
    } else drawBoard(motion);
  }

  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      if (view === tab.dataset.view) return;
      view = tab.dataset.view;
      for (const control of tabs) control.setAttribute("aria-pressed", String(control === tab));
      draw("enter");
    });
  }

  el("latest").addEventListener("click", () => {
    follow = true;
    moveFeed(feed.scrollHeight);
    updateFollow();
  });

  window.emberWidgetSnapshot = (value) => {
    if (value?.version !== 1) return;
    const changed = !snapshot || snapshot.revision !== value.revision;
    snapshot = value;
    cards.classList.toggle("reduce-motion", !!value.chatPrefs?.reducedMotion);
    if (changed) activityMode = activityOf(value);
    updateTaskTimes();
    connection();
    if (changed) {
      if (view === "tabs") drawChat();
      else if (view !== "overview" || displayedReport !== (value.report ?? window.emberUsageBootstrap)?.at) drawBoard("report");
    }
  };

  let needSnapshot = true;
  window.emberRevision = (revision, at) => {
    if (revision !== snapshot?.revision || Date.now() - at > 10000) needSnapshot = true;
    else { snapshot.at = at; updateTaskTimes(); }
  };

  function refresh() {
    if (loading) return;
    loading = true;
    const asset = document.createElement("script");
    const marker = snapshot?.hasRevision && !needSnapshot;
    needSnapshot = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      asset.remove();
      loading = false;
      connection();
      const readingChat = view === "tabs" && !document.hidden;
      setTimeout(refresh, needSnapshot ? 0 : readingChat && snapshot?.hasRevision ? 500 : 2500);
    };
    const timeout = setTimeout(finish, 3500);
    asset.onload = finish;
    asset.onerror = () => { finish(); if (marker) needSnapshot = true; };
    asset.src = (marker ? "revision.js?t=" : "snapshot.js?t=") + Date.now();
    document.head.append(asset);
  }

  window.addEventListener("resize", () => draw());
  draw();
  refresh();

})();
