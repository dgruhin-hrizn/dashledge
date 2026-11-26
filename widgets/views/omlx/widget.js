(() => {
  const $ = (id) => document.getElementById(id);
  const views = [...document.querySelectorAll("[data-view]")];
  const filters = [...document.querySelectorAll("[data-filter]")];
  const host = window.Zurface ?? window.Zeon;
  const history = new Map();
  const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
  const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
  const windowMs = 120_000;
  const staleAfter = 12_000;
  let view = "overview";
  let snapshot;
  let selected;
  let pending = false;
  let choosing = false;
  let modelIndex = 0;
  let modelFilter = "all";
  let directTouch = false;
  let serverIndex = 0;
  let chartAccent = "#a0efcb";
  let instance;
  let confirmation;
  let action;
  let actionMessage;

  const format = (value, formatter = number) => value == null ? "—" : formatter.format(value);
  const gib = (value) => value == null ? null : value / 1024 ** 3;
  const bytes = (value) => value == null ? "—" : format(gib(value)) + " GiB";
  const tps = (value) => format(value) + " tok/s";
  function set(id, text) {
    if ($(id).textContent !== text) $(id).textContent = text;
  }

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function duration(seconds) {
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days) return days + "d " + hours % 24 + "h";
    if (hours) return hours + "h " + minutes % 60 + "m";
    return minutes ? minutes + "m" : Math.floor(seconds) + "s";
  }

  function ratio(value, total) {
    return value != null && total > 0 ? Math.min(1, Math.max(0, value / total)) : null;
  }

  function track(id, portion) {
    const bar = $(id + "-track");
    bar.hidden = portion == null;
    if (portion != null) {
      $(id + "-fill").style.width = portion * 100 + "%";
      if (bar.getAttribute("role") === "meter") {
        bar.setAttribute("aria-valuemin", "0");
        bar.setAttribute("aria-valuemax", "100");
        bar.setAttribute("aria-valuenow", Math.round(portion * 100));
      }
    }
  }

  // oMLX rounds its cumulative rate to 0.1 tok/s. Reject duration deltas
  // whose rounding uncertainty exceeds 10% of the inferred interval.
  function completedPrefillRate(before,after) {
    if (!before || before.error || after.error || after.requests <= before.requests ||
        !(after.at > before.at && after.at-before.at <= 3500) ||
        !(after.uptime >= before.uptime) || !(after.avgPrefill > 0)) return null;
    if (![before.input,before.cached,after.input,after.cached,before.requests,after.requests,
          before.uptime,after.uptime].every(Number.isFinite) ||
        before.input > after.input || before.cached > after.cached) return null;
    const oldTokens = before.input-before.cached, tokens = after.input-after.cached;
    if (oldTokens < 0 || tokens <= oldTokens || (oldTokens && !(before.avgPrefill > 0))) return null;
    const oldSeconds = oldTokens ? oldTokens/before.avgPrefill : 0;
    const seconds = tokens/after.avgPrefill-oldSeconds;
    const error = tokens/after.avgPrefill*.05/(after.avgPrefill-.05) +
      (oldTokens ? oldSeconds*.05/(before.avgPrefill-.05) : 0);
    return seconds > 0 && error <= .1*seconds ? (tokens-oldTokens)/seconds : null;
  }

  function drawTrend(address, state, rate) {
    const canvas = $("trend");
    const { width, height } = canvas.getBoundingClientRect();
    if (!width || !height) return;

    const points = history.get(address) ?? [];
    const peak = Math.max(1,...points.map(p => Math.max(p.prefill ?? 0,p.estimate ?? 0)));
    let path = "", marks = "", previous = null;
    for (const point of points) {
      const x = 3 + 494*(1-(snapshot.at-point.at)/windowMs);
      const y = rate => 29-27*rate/peak;
      if (point.estimate != null) {
        marks += "M"+x.toFixed(2)+" 29V"+y(point.estimate).toFixed(2)+" ";
      }
      if (point.prefill == null) { previous = null; continue; }
      const connected = previous != null && point.at-previous <= 3500;
      path += (connected ? "L" : "M")+x.toFixed(2)+" "+y(point.prefill).toFixed(2)+" ";
      if (!connected) path += "h0.35 ";
      previous = point.at;
    }
    $("prefill-path").setAttribute("d",path);
    $("prefill-completed").setAttribute("d",marks);
    const last = points.at(-1);
    const recent = points.findLast(p => p.estimate != null || p.prefill != null);
    const detail = last?.prefill != null ? tps(last.prefill) :
      [last?.phase ?? "Unavailable", recent && ("last "+(recent.estimate != null ? "≈" : "")+
        tps(recent.estimate ?? recent.prefill))].filter(Boolean).join(" · ");
    set("prefill-caption","Prefill · "+detail);
    const measured = points.filter((point) => point.rate != null);
    const message = state !== "Online" ? (measured.length ? "Last recorded activity" : "Throughput unavailable")
      : rate == null ? "Live metrics unavailable" : measured.length < 2 ? "Collecting samples…" : "";
    set("trend-state", message);
    $("trend-state").hidden = !message;
    const high = Math.max(0, ...measured.map(({ rate }) => rate));
    const step = high > 100 ? 50 : high > 20 ? 10 : 5;
    const max = Math.max(step, Math.ceil(high / step) * step);
    set("trend-max", measured.length ? tps(max) : "");
    const scale = Math.min(window.devicePixelRatio || 1, 3);
    const pixelWidth = Math.ceil(width * scale), pixelHeight = Math.ceil(height * scale);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    const ctx = canvas.getContext("2d");
    set("decode-peak", measured.length ? tps(high) : "—");
    if (!ctx) return;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!measured.length) return;

    const end = Math.max(snapshot?.at ?? 0, points.at(-1).at);
    const floor = height - 2;
    const groups = [];
    let segment = [];
    let prev;
    for (const { at, rate } of points) {
      if (rate == null || (prev != null && at - prev > 3500)) {
        if (segment.length) groups.push(segment);
        segment = [];
      }
      if (rate != null) segment.push({
        x: 3 + (1 - (end - at) / windowMs) * (width - 6),
        y: floor - rate / max * Math.max(0, height - 18),
      });
      prev = at;
    }
    if (segment.length) groups.push(segment);

    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, chartAccent);
    gradient.addColorStop(1, "transparent");
    ctx.lineWidth = 1.6;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = chartAccent;
    for (const group of groups) {
      const first = group[0];
      const last = group.at(-1);
      if (group.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < group.length; i++) {
        const left = group[i - 1], right = group[i];
        const mid = (left.x + right.x) / 2;
        ctx.bezierCurveTo(mid, left.y, mid, right.y, right.x, right.y);
      }
      ctx.stroke();
      ctx.lineTo(last.x, floor);
      ctx.lineTo(first.x, floor);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.globalAlpha = .26;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    const latest = groups.at(-1).at(-1);
    ctx.beginPath();
    ctx.arc(latest.x, latest.y, 2.5, 0, 2 * Math.PI);
    ctx.fillStyle = chartAccent;
    ctx.fill();
  }

  function renderResidents(data) {
    const list = $("resident-list");
    const models = (data?.models ?? []).filter(model => model.loaded || model.loading);
    set("resident-count", format(data?.loaded));
    const rows = new Map([...list.querySelectorAll("article")].map(row => [row.dataset.id,row]));
    if (!models.length) {
      const message = data ? "No resident models reported" : "Waiting for server";
      if (list.textContent !== message) list.replaceChildren(element("p", message));
      return;
    }
    list.querySelector("p")?.remove();
    models.forEach((model,index) => {
      let row = rows.get(model.id);
      if (!row) {
        row = element("article");
        row.dataset.id = model.id;
        row.append(element("strong"),element("small"),element("span"),element("div","","request-details"));
      }
      rows.delete(model.id);
      const stage = model.loading ? "Loading" : model.generating ? "Decoding" :
        model.prefilling?.length ? "Prefill" : model.queued ? "Queued" :
        model.active ? "Active" : model.decode == null ? "Resident" : "Idle";
      const size = model.actualBytes != null ? bytes(model.actualBytes) :
        model.estimatedBytes != null ? "≈ "+bytes(model.estimatedBytes) : "";
      const idle = stage === "Idle" && !model.pinned && model.idleTtl != null ? "Unload in "+duration(model.idleTtl) : "";
      const values = [(model.pinned ? "📌 " : "")+model.name, [stage, size, idle].filter(Boolean).join(" · "),
        model.generating && model.decode != null ? tps(model.decode) : ""];
      values.forEach((v,i) => { if(row.children[i].textContent !== v) row.children[i].textContent = v; });
      const details = row.lastElementChild;
      const signature = JSON.stringify([model.loadingElapsed,model.loadingRemaining,model.generations,model.prefilling]);
      if (details.dataset.signature !== signature) {
        details.dataset.signature = signature;
        const lines = [];
        if (model.loading) {
          const times = [model.loadingElapsed != null && duration(model.loadingElapsed)+" elapsed",
            model.loadingRemaining != null && "~"+duration(model.loadingRemaining)+" left"].filter(Boolean);
          if (times.length) lines.push(element("div",times.join(" · ")));
        }
        for (const [index,r] of (model.prefilling ?? []).entries()) {
          const line = element("div","Prefill "+(index+1)+" · "+format(r.done)+" / "+format(r.total)+" tokens");
          if (r.rate != null) line.append(" · "+tps(r.rate));
          if (r.eta != null) line.append(" · ~"+duration(r.eta)+" left");
          if (r.total > 0 && r.done != null) {
            const bar = element("progress"); bar.max = r.total; bar.value = r.done;
            bar.setAttribute("aria-label","Prompt tokens processed"); line.append(bar);
          }
          lines.push(line);
        }
        for (const [index,r] of (model.generations ?? []).entries()) {
          lines.push(element("div",["Decode "+(index+1), r.rate != null && tps(r.rate),
            r.tokens != null && format(r.tokens)+" tokens", r.elapsed != null && duration(r.elapsed)+" elapsed"].filter(Boolean).join(" · ")));
        }
        details.replaceChildren(...lines);
      }
      row.dataset.busy = String(["Loading","Decoding","Prefill","Active"].includes(stage));
      if(list.children[index] !== row) list.insertBefore(row,list.children[index] ?? null);
    });
    for(const row of rows.values()) row.remove();
  }

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let decodeAddress;
  let decodeFrame;
  let displayedRate = null;
  let targetRate = null;

  const decodeFormat = new Intl.NumberFormat(undefined, {
    notation: "compact", minimumFractionDigits: 1, maximumFractionDigits: 1,
  });
  function paintDecode(rate) {
    displayedRate = rate;
    const parts = rate == null ? [] : decodeFormat.formatToParts(rate);
    const integer = parts.find(part => part.type === "integer");
    const suffix = parts.find(part => part.type === "compact")?.value ?? "";
    const fraction = parts.filter(part => part.type === "decimal" || part.type === "fraction")
      .map(part => part.value).join("");
    set("decode-integer", rate === 0 ? "00" : integer?.value ?? "—");
    $("decode-unit").hidden = rate == null;
    set("decode-fraction", fraction + suffix);
  }

  function updateDecode(address, rate, online) {
    const target = Number.isFinite(rate) ? rate : null;
    const immediate = !online || address !== decodeAddress || displayedRate === null ||
      target === null || reducedMotion.matches || document.hidden;
    if (!immediate && target === targetRate) return;
    cancelAnimationFrame(decodeFrame);
    decodeAddress = address;
    targetRate = target;
    if (immediate || Math.abs(displayedRate - target) < 1) {
      paintDecode(target);
      return;
    }

    const from = displayedRate;
    const start = performance.now();
    // Leave time to read the measured rate between one-second samples.
    const transitionMs = 800;
    const paintInterval = target === 0 ? 80 : 125;
    let lastPaint = start;
    function step(now) {
      const progress = Math.min(1, Math.max(0, (now - start) / transitionMs));
      if (progress === 1 || reducedMotion.matches) {
        paintDecode(target);
        return;
      }
      if (now - lastPaint >= paintInterval) {
        const eased = progress * progress * (3 - 2 * progress);
        paintDecode(from + (target - from) * eased);
        lastPaint = now;
      }
      decodeFrame = requestAnimationFrame(step);
    }
    decodeFrame = requestAnimationFrame(step);
  }

  function renderOverview(data, server, state) {
    const mac = snapshot?.mac;
    const identity = [mac?.model, mac?.chip].filter(Boolean).join(" · ");
    const config = [mac?.cpu && mac.cpu + "-core CPU", mac?.gpu && mac.gpu + "-core GPU",
      mac?.memory && mac.memory + " RAM"].filter(Boolean).join(" · ");
    $("mac-specs").hidden = !identity && !config;
    set("mac-chip", ["This Mac", identity].filter(Boolean).join(" · "));
    set("mac-config", config);
    updateDecode(server?.address, data?.liveDecode, state === "Online");
    set("active", format(data?.active));
    set("queued", format(data?.queued));
    set("avg-decode", format(data?.avgDecode));
    set("avg-prefill", format(data?.avgPrefill));
    set("overview-loaded", format(data?.loaded));
    set("overview-cache", data?.hitRate == null ? "—" : format(data.hitRate) + "%");
    set("overview-room", bytes(data?.headroomBytes));
    renderResidents(data);
    const process = data?.processBytes;
    const tracked = process ?? data?.poolBytes;
    set("memory-total", bytes(tracked));
    set("memory-limit", data?.limit == null ? "" : "/ " + bytes(data.limit));
    set("memory-detail", process == null ? "Model pool"
      : "Process footprint · " + bytes(data.poolBytes) + " model pool");
    const pressure = data?.pressure;
    set("pressure", pressure === "ok" ? "Normal" : pressure ?? "");
    $("pressure").dataset.level = pressure ?? "";
    track("memory", ratio(tracked, data?.limit));
    drawTrend(server?.address, state, data?.liveDecode);
  }

  function modelRow(model, enabled) {
    const row = element("li", "", "surface model");
    row.dataset.model = model.id ?? model.name;
    const title = element("div", "", "model-title");
    const residency = model.loading ? "Loading" : model.loaded === false ? "Unloaded" : "Loaded";
    const meta = [residency, model.type, model.distributed && "Distributed", model.pinned && "Pinned",
      model.context && format(model.context, compact) + " context",
      model.idleTtl != null && "TTL " + duration(model.idleTtl)].filter(Boolean).join(" · ");
    const name = element("strong", model.name);
    name.title = model.name;
    title.append(name);
    if (meta) title.append(element("small", meta));
    const prefill = model.prefilling[0];
    const progress = ratio(prefill?.done, prefill?.total);
    if (progress != null) {
      const track = element("div", "", "track");
      track.setAttribute("role", "meter");
      track.setAttribute("aria-label", "Prefill progress");
      track.setAttribute("aria-valuemin", "0");
      track.setAttribute("aria-valuemax", "100");
      track.setAttribute("aria-valuenow", Math.floor(progress * 100));
      const fill = element("span");
      fill.style.width = progress * 100 + "%";
      track.append(fill);
      title.append(track);
    }

    const memory = model.actualBytes ?? model.estimatedBytes;
    const value = model.loading ? "Loading" : (model.actualBytes == null && memory != null ? "≈ " : "") + bytes(memory);
    const usage = element("div", "", "model-usage");
    if (model.loaded === false && memory != null) usage.title = "Estimated memory when loaded";
    usage.append(element("strong", value));
    if (model.loaded === false && !model.loading) {
      const fit = model.loadFit === true ? "Fits now" : model.loadFit === false ? "Needs room" : "Fit unknown";
      const indicator = element("small", fit, "model-fit");
      indicator.dataset.fit = String(model.loadFit ?? "unknown");
      usage.append(indicator);
    }
    const work = [prefill && (progress == null ? "Prefill" : "Prefill " + Math.floor(progress * 100) + "%"),
      prefill?.rate != null && tps(prefill.rate), prefill?.eta != null && duration(prefill.eta) + " left",
      model.prefilling.length > 1 && "+" + (model.prefilling.length - 1) + " prefill",
      model.decode > 0 && tps(model.decode), model.active > 0 && model.active + " active",
      model.queued > 0 && model.queued + " queued"].filter(Boolean).join(" · ");
    if (work) {
      const details = element("small", work);
      details.title = work;
      usage.append(details);
    }
    row.append(title, usage);
    if (enabled && model.controllable) {
      const operation = model.loaded ? "unload" : "load";
      const busy = action?.model === model.id && action.address === selected;
      const button = element(directTouch ? "span" : "button",
        busy ? "Working" : operation === "load" ? "Load" : "Unload", "model-action");
      if (directTouch) button.setAttribute("aria-hidden", "true");
      else button.type = "button";
      button.dataset.action = operation;
      button.dataset.model = model.id;
      const blocked = operation === "load" && model.loadFit === false;
      button.disabled = Boolean(action) || model.loading || blocked;
      button.dataset.disabled = String(button.disabled);
      const description = (operation === "load" ? "Load " : "Unload ") + model.name;
      const accessibleName = description + (blocked ? ". Insufficient memory headroom." : "");
      if (directTouch) button.dataset.touchLabel = accessibleName;
      else button.setAttribute("aria-label", accessibleName);
      row.append(button);
    }
    return row;
  }

  function updateModelRows(list, models, enabled) {
    const existing = [...list.children];
    const next = models.map((model) => modelRow(model, enabled));
    // Preserve a model's native target when only its telemetry changes.
    if (next.length !== existing.length || next.some((row, index) =>
      row.dataset.model !== existing[index].dataset.model ||
      row.children.length !== existing[index].children.length)) {
      list.replaceChildren(...next);
      return;
    }
    for (const [index, row] of next.entries()) {
      const [title, usage, button] = row.children;
      const [oldTitle, oldUsage, oldButton] = existing[index].children;
      oldTitle.replaceWith(title);
      oldUsage.replaceWith(usage);
      if (!button) continue;
      if (oldButton.tagName !== button.tagName || oldButton.dataset.action !== button.dataset.action) oldButton.replaceWith(button);
      else {
        if (oldButton.disabled !== button.disabled) oldButton.disabled = button.disabled;
        if (oldButton.dataset.disabled !== button.dataset.disabled) oldButton.dataset.disabled = button.dataset.disabled;
        if (oldButton.textContent !== button.textContent) oldButton.textContent = button.textContent;
        if (directTouch) oldButton.dataset.touchLabel = button.dataset.touchLabel;
        else oldButton.setAttribute("aria-label", button.getAttribute("aria-label"));
      }
    }
  }

  function paginate(kind, total, perPage, index) {
    const start = Math.min(Math.floor(index / perPage) * perPage, Math.floor(Math.max(0, total - 1) / perPage) * perPage);
    const end = Math.min(total, start + perPage);
    $(kind + "-pages").hidden = total <= perPage;
    $(kind + "-prev").disabled = start === 0;
    $(kind + "-next").disabled = end >= total;
    $(kind + "-prev").dataset.index = Math.max(0, start - perPage);
    $(kind + "-next").dataset.index = end;
    set(kind + "-page", (start + 1) + "–" + end + " of " + total);
    return [start, end];
  }

  function renderModels(data, enabled) {
    const inventory = data?.models ?? [];
    const models = modelFilter === "unloaded" ? inventory.filter((model) => model.loaded === false && !model.loading) : inventory;
    for (const button of filters) button.setAttribute("aria-pressed", String(button.dataset.filter === modelFilter));
    const area = $("model-space");
    const pages = $("models-pages");
    const layout = window.getComputedStyle(area);
    const inlinePager = layout.getPropertyValue("--inline-pager").trim() === "1";
    const free = area.clientHeight + (pages.hidden || inlinePager ? 0 : pages.offsetHeight + 7);
    const rowHeight = free < 140 ? enabled ? 50 : 44 : free < 248 ? 52 : 64;
    const columns = Number.parseInt(layout.getPropertyValue("--model-columns"), 10) || 1;
    const fits = (height) => columns * Math.max(1, Math.floor((height + 6) / (rowHeight + 6)));
    const room = fits(free);
    const perPage = models.length > room && !inlinePager ? fits(free - 51) : room;
    const [start, end] = paginate("models", models.length, perPage, modelIndex);
    modelIndex = start;
    const list = $("model-list");
    const visible = models.slice(start, end);
    const signature = JSON.stringify([enabled, directTouch, action, selected, visible]);
    list.style.setProperty("--model-height", rowHeight + "px");
    if (list.dataset.signature !== signature) {
      updateModelRows(list, visible, enabled);
      list.dataset.signature = signature;
    }
    const loading = inventory.filter((model) => model.loading).length;
    set("models-headroom", !data ? "" : data.headroomBytes == null ? "Headroom unavailable" : bytes(data.headroomBytes) + " headroom");
    set("models-total", data ? [format(data.loaded) + " loaded", loading ? loading + " loading" : "",
      data.discovered == null ? "" : format(data.discovered) + " available"].filter(Boolean).join(" · ") : "");
    set("models-empty", data ? modelFilter === "unloaded" ? "No unloaded models." : "No models found." : "Model data unavailable.");
    $("models-empty").hidden = models.length > 0;
  }

  function canControl(server) {
    return Boolean(instance && snapshot?.actions && server?.canControl && Date.now() - snapshot.at <= staleAfter);
  }

  function currentModel(id) {
    const server = snapshot?.servers.find(({ address }) => address === selected);
    if (!canControl(server) || action) return null;
    return server.models.find((model) => model.id === id && model.controllable && !model.loading);
  }

  async function sendAction(model, operation) {
    const at = Date.now();
    const id = Array.from(window.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const command = { id, at, address: selected, model: model.id, action: operation };
    action = command;
    actionMessage = { address: selected, text: operation === "load" ? "Loading " + model.name + "…" : "Unloading " + model.name + "…" };
    render();
    try {
      await host.command("storage.set", { key: "omlx.modelAction", value: JSON.stringify(command) });
    } catch {
      if (action?.id !== id) return;
      action = null;
      actionMessage = { address: command.address, text: "Zurface could not send the model action." };
      render();
    }
  }

  function updateAction() {
    if (!action) return;
    const receipt = snapshot?.actions?.[instance];
    const matching = receipt?.id === action.id;
    if (matching && receipt.status === "pending") {
      action.accepted = true;
      return;
    }
    if (!matching && !action.accepted && Date.now() - action.at < 32_000) return;
    actionMessage = { address: action.address, text: matching ? receipt.message : "Action response unavailable. Check the model state." };
    action = null;
  }

  let weekSignature;
  function renderWeek(week) {
    const signature = JSON.stringify([selected,week]);
    if (signature === weekSignature) return;
    weekSignature = signature;
    const grid = $("week-grid"), speeds = $("week-speeds");
    grid.replaceChildren(); speeds.replaceChildren();
    if (!week) {
      grid.textContent = speeds.textContent = "Weekly history unavailable";
      return;
    }
    const max = Math.max(1,...week.days.flatMap(day => day.tokens));
    for (const day of week.days) {
      const cells = element("div","","heat-row");
      const date = new Date(day.date+"T12:00:00");
      cells.append(element("small",date.toLocaleDateString(undefined,{weekday:"short"})));
      day.tokens.forEach((count,hour) => {
        const cell = element("i");
        cell.style.setProperty("--heat", count ? (18+82*Math.sqrt(count/max))+"%" : "0%");
        cell.title = day.date+" "+hour+":00 · "+format(count)+" tokens";
        cells.append(cell);
      });
      grid.append(cells);
    }
    for (const model of week.speeds) {
      const row = element("div","","speed-row");
      row.append(element("strong",model.name),element("small",tps(model.rate)));
      const bar = element("i"); bar.style.width = (100*model.rate/(week.speeds[0].rate||1))+"%";
      row.append(bar); speeds.append(row);
    }
    if (!week.speeds.length) speeds.textContent = "No timed generations";
  }

  function renderUsage(data) {
    renderWeek(data?.week);
    const total = data?.input == null || data.output == null ? null : data.input + data.output;
    set("tokens-total", format(total, compact));
    set("requests", format(data?.requests, compact));
    set("tokens-prompt", format(data?.input, compact));
    set("tokens-output", format(data?.output, compact));
    set("tokens-cached", format(data?.cached, compact));
    set("cache-hit", data?.hitRate == null ? "—" : format(data.hitRate) + "%");
    track("cache", ratio(data?.hitRate, 100));
    track("token", total > 0 ? ratio(data.input, total) : null);
  }

  function showPicker(servers, stale) {
    const options = $("server-options");
    const pages = $("servers-pages");
    const free = options.clientHeight + (pages.hidden ? 0 : pages.offsetHeight + 7);
    const fits = (height) => Math.max(1, Math.floor((height + 6) / 50));
    const room = fits(free);
    const perPage = servers.length > room ? fits(free - 51) : room;
    const [start, end] = paginate("servers", servers.length, perPage, serverIndex);
    serverIndex = start;
    const visible = servers.slice(start, end);
    const signature = JSON.stringify([stale, selected, visible.map(({ name, address, error }) => [name, address, Boolean(error)])]);
    if (options.dataset.signature !== signature) {
      options.replaceChildren(...visible.map((server) => {
        const online = !stale && !server.error;
        const button = element("button", "", "server-option");
        button.type = "button";
        button.dataset.address = server.address;
        button.setAttribute("aria-pressed", String(server.address === selected));
        const name = element("strong", server.name, "option-name");
        name.title = server.address;
        const signal = element("span", online ? "Online" : stale ? "Stale" : "Offline", "option-state");
        signal.dataset.online = String(online);
        button.append(name, signal);
        return button;
      }));
      options.dataset.signature = signature;
    }
    const online = stale ? 0 : servers.filter((server) => !server.error).length;
    set("fleet", online + " of " + servers.length + " online");
  }

  function render() {
    updateAction();
    const servers = snapshot?.servers ?? [];
    const server = servers.find(({ address }) => address === selected) ?? servers[0];
    if (server) selected = server.address;
    if (servers.length < 2) choosing = false;
    const stale = Boolean(snapshot && Date.now() - snapshot.at > staleAfter);
    const data = server?.last ?? (server?.at ? server : null);
    const state = !snapshot ? "Connecting" : stale ? "Stale" :
      server?.error ? data ? "Stale" : "Offline" : server ? "Online" : "Setup";
    set("status", state);
    $("status").dataset.state = state.toLowerCase();
    set("server-label", servers.length === 1 ? server.name : "");
    set("server-name", server?.name ?? "");
    $("server-toggle").hidden = servers.length < 2;
    $("server-toggle").setAttribute("aria-expanded", String(choosing));

    for (const control of views) {
      const current = control.dataset.view === view;
      control.setAttribute("aria-pressed", String(current));
      $(control.dataset.view).hidden = !current || choosing || Boolean(confirmation);
    }
    if ($("overview").hidden) {
      cancelAnimationFrame(decodeFrame);
      decodeAddress = undefined;
    }
    $("server-picker").hidden = !choosing;
    $("confirm-unload").hidden = !confirmation;
    if (confirmation) {
      set("unload-model", confirmation.name);
      $("apply-unload").disabled = confirmation.address !== selected || !currentModel(confirmation.id)?.loaded;
    }

    const footer = [server && new URL(server.address).host, data?.version && "v" + data.version,
      data?.uptime != null && "Up " + duration(data.uptime), data && time.format(data.at)].filter(Boolean);
    set("updated", footer.join(" · ") || "Waiting for data");
    const message = snapshot?.error ?? server?.error ?? (stale ? "Collector stopped updating." :
      (actionMessage?.address === selected ? actionMessage?.text : null) ?? data?.notice);
    set("message", message ?? "");
    $("message").title = message ?? "";

    if (choosing) showPicker(servers, stale);
    else if (confirmation) return;
    else if (view === "overview") renderOverview(data, server, state);
    else if (view === "models") renderModels(data, canControl(server));
    else renderUsage(data);
  }

  // Zurface serves the collector snapshot as a local asset.
  window.omlxWidgetSnapshot = (value) => {
    if (value?.schema !== 1 || !Array.isArray(value.servers) || snapshot?.at === value.at) return;
    const previousSnapshot = snapshot;
    snapshot = value;
    const addresses = new Set(value.servers.map(({ address }) => address));
    for (const address of history.keys()) if (!addresses.has(address) && !value.error) history.delete(address);
    for (const server of value.servers) {
      const points = history.get(server.address) ?? [];
      const jobs = (server.models ?? []).flatMap(model => model.prefilling ?? []);
      const hasActivity = server.liveDecode != null || jobs.length > 0 || server.models?.some(model => model.generating > 0);
      const prior = previousSnapshot?.servers.find(s => s.address === server.address);
      const estimate = completedPrefillRate(prior,server);
      const live = jobs.length && jobs.every(job => job.rate > 0)
        ? jobs.reduce((sum,job) => sum + job.rate,0) : null;
      points.push({ at: server.at ?? value.at, rate: server.liveDecode ?? null, prefill:live,
        estimate, phase: jobs.length ? "Measuring" : hasActivity ? "Idle" : "Unavailable" });
      history.set(server.address, points.filter((point) => point.at >= value.at - windowMs));
    }
    render();
  };

  function refresh() {
    if (pending) return;
    pending = true;
    const asset = element("script");
    const finish = () => {
      clearTimeout(timeout);
      asset.remove();
      pending = false;
      if (snapshot && Date.now() - snapshot.at > staleAfter && $("status").dataset.state !== "stale") render();
    };
    const timeout = setTimeout(finish, 3000);
    asset.onload = finish;
    asset.onerror = finish;
    asset.src = "snapshot.js?t=" + Date.now();
    document.head.append(asset);
  }

  for (const button of views) {
    button.addEventListener("click", () => {
      choosing = false;
      confirmation = null;
      view = button.dataset.view;
      render();
    });
  }
  $("server-toggle").addEventListener("click", () => {
    confirmation = null;
    choosing = !choosing;
    render();
  });
  for (const button of filters) button.addEventListener("click", () => {
    modelFilter = button.dataset.filter;
    modelIndex = 0;
    render();
  });
  $("model-list").addEventListener("click", (event) => {
    const button = event.target.closest(".model-action[data-action]");
    if (!button || button.dataset.disabled === "true") return;
    const model = currentModel(button.dataset.model);
    if (!model) return;
    if (button.dataset.action === "unload" && model.loaded) {
      confirmation = { id: model.id, name: model.name, address: selected };
      render();
      $("cancel-unload").focus();
    } else if (button.dataset.action === "load" && !model.loaded && model.loadFit !== false) {
      void sendAction(model, "load");
    }
  });
  $("cancel-unload").addEventListener("click", () => {
    confirmation = null;
    render();
  });
  $("apply-unload").addEventListener("click", () => {
    const model = confirmation?.address === selected ? currentModel(confirmation?.id) : null;
    confirmation = null;
    if (model?.loaded) void sendAction(model, "unload");
    else render();
  });
  $("server-options").addEventListener("click", (event) => {
    const option = event.target.closest("button[data-address]");
    if (!option) return;
    selected = option.dataset.address;
    choosing = false;
    modelIndex = 0;
    render();
    $("server-toggle").focus();
  });
  for (const direction of ["prev", "next"]) {
    $("models-" + direction).addEventListener("click", (event) => {
      modelIndex = Number(event.currentTarget.dataset.index);
      render();
    });
    $("servers-" + direction).addEventListener("click", (event) => {
      serverIndex = Number(event.currentTarget.dataset.index);
      render();
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && confirmation) {
      confirmation = null;
      render();
    }
    if (event.key === "Escape" && choosing) {
      choosing = false;
      render();
      $("server-toggle").focus();
    }
  });
  $("refresh").addEventListener("click", refresh);
  window.addEventListener("resize", render);
  host?.subscribe(({ theme, instanceID, touchMode }) => {
    const identityChanged = instanceID !== instance;
    const touchChanged = directTouch !== (touchMode === true);
    directTouch = touchMode === true;
    const paletteChanged = theme?.accent && theme.accent !== chartAccent;
    if (paletteChanged) chartAccent = theme.accent;
    instance = instanceID;
    if (identityChanged || touchChanged || (paletteChanged && view === "overview" && !choosing)) render();
  });
  render();
  refresh();
  setInterval(refresh, 500);
})();
