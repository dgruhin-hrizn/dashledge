(() => {
  const M = globalThis.omlxModel;
  const $ = (id) => document.getElementById(id);
  const SVG = "http://www.w3.org/2000/svg";
  const root = document.documentElement;
  const views = [...document.querySelectorAll("[data-view]")];
  const filters = [...document.querySelectorAll("[data-filter]")];
  // Dashledge's package SDK: theme, instance details and the manifest's `model` command.
  const host = window.Dashledge;
  const history = new Map();
  const activity = new Map();
  const averages = new Map();
  const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
  const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
  const whole = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const seconds = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
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
  let serverIndex = 0;
  let chartAccent = "#a0efcb";
  let instance;
  let viewport;
  let confirmation;
  let action;
  let actionMessage;
  let previewed = null;
  let scale = 1;

  const format = (value, formatter = number) => value == null ? "—" : formatter.format(value);
  const gib = (value) => value == null ? "—" : format(M.gib(value)) + " GiB";
  const tps = (value) => format(value) + " tok/s";
  function set(id, text) {
    const node = typeof id === "string" ? $(id) : id;
    if (node.textContent !== text) node.textContent = text;
  }
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function icon(name, className) {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", name === "chevron" ? "0 0 12 12" : "0 0 20 20");
    svg.setAttribute("aria-hidden", "true");
    if (className) svg.setAttribute("class", className);
    const use = document.createElementNS(SVG, "use");
    use.setAttribute("href", "#" + name);
    svg.append(use);
    return svg;
  }
  function glyph(type, label) {
    const kind = M.glyphType(type);
    const tile = element("span", "", "glyph-tile");
    tile.dataset.glyph = kind;
    const svg = icon("g-" + kind);
    if (label) {
      svg.removeAttribute("aria-hidden");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", label);
    }
    tile.append(svg);
    return tile;
  }
  function ring(fraction, size, radius, className, label) {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 " + size + " " + size);
    svg.setAttribute("class", "ring " + className);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
    for (const kind of ["ring-track", "ring-fill"]) {
      const circle = document.createElementNS(SVG, "circle");
      circle.setAttribute("class", kind);
      circle.setAttribute("cx", size / 2);
      circle.setAttribute("cy", size / 2);
      circle.setAttribute("r", radius);
      svg.append(circle);
    }
    setRing(svg.lastChild, fraction);
    return svg;
  }
  function setRing(circle, fraction) {
    const length = 2 * Math.PI * Number(circle.getAttribute("r"));
    const filled = fraction == null ? 0 : Math.max(0, Math.min(1, fraction)) * length;
    circle.setAttribute("stroke-dasharray", filled.toFixed(1) + " " + length.toFixed(1));
    circle.style.opacity = fraction ? "1" : "0";
  }
  function setWidth(node, portion) {
    const value = portion == null ? "0%" : Math.max(0, Math.min(1, portion)) * 100 + "%";
    if (node.style.width !== value) node.style.width = value;
  }

  // The SDK sets --px-scale; layout follows the frame's reference-canvas size.
  function measure() {
    const value = Number.parseFloat(getComputedStyle(root).getPropertyValue("--px-scale"));
    scale = value > 0 ? value : 1;
    const layout = M.layoutFor(window.innerWidth, window.innerHeight, scale);
    if (root.dataset.layout !== layout) root.dataset.layout = layout;
    return layout;
  }

  // ---- Live decode chart ----------------------------------------------------
  function canvasContext(canvas) {
    const { width, height } = canvas.getBoundingClientRect();
    if (!width || !height) return null;
    const ratio = Math.min(window.devicePixelRatio || 1, 3);
    const pixelWidth = Math.ceil(width * ratio), pixelHeight = Math.ceil(height * ratio);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return { ctx, width, height };
  }

  function traceGroups(points, toX, toY) {
    const groups = [];
    let segment = [], prev;
    for (const { at, rate } of points) {
      if (rate == null || (prev != null && at - prev > 3500)) {
        if (segment.length) groups.push(segment);
        segment = [];
      }
      if (rate != null) segment.push({ x: toX(at), y: toY(rate) });
      prev = at;
    }
    if (segment.length) groups.push(segment);
    return groups;
  }

  function strokeTrace(ctx, groups, floor, { fill = true, dash = null, alpha = 1 } = {}) {
    const gradient = ctx.createLinearGradient(0, 0, 0, floor);
    gradient.addColorStop(0, chartAccent);
    gradient.addColorStop(1, "transparent");
    ctx.lineWidth = 1.8 * scale;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = chartAccent;
    ctx.setLineDash(dash ?? []);
    for (const group of groups) {
      if (group.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(group[0].x, group[0].y);
      for (let i = 1; i < group.length; i++) {
        const left = group[i - 1], right = group[i];
        const mid = (left.x + right.x) / 2;
        ctx.bezierCurveTo(mid, left.y, mid, right.y, right.x, right.y);
      }
      ctx.globalAlpha = alpha;
      ctx.stroke();
      if (fill) {
        ctx.lineTo(group.at(-1).x, floor);
        ctx.lineTo(group[0].x, floor);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.globalAlpha = .3 * alpha;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    ctx.setLineDash([]);
  }

  function drawTrend(server, state, data, mode) {
    const points = history.get(server?.address) ?? [];
    const memory = activity.get(server?.address);
    const canvas = $("trend");
    const surface = canvasContext(canvas);
    const glow = $("glow"), markers = $("markers");
    const measured = points.filter((point) => point.rate != null);
    const high = Math.max(0, ...measured.map(({ rate }) => rate));
    const max = M.chartCeiling(high);
    set("decode-peak", measured.some((point) => point.rate > 0) ? number.format(high) : "—");
    set("trend-max", high > 0 ? max + " tok/s" : "");
    const end = snapshot?.at ?? Date.now();
    const last = memory?.last;
    const ghost = mode === "idle" && last && last.end < end - windowMs && !measured.some((point) => point.rate > 0) ? last : null;
    const message = state !== "Online" ? (measured.length ? "Last recorded activity" : "Throughput unavailable")
      : mode === "unavailable" ? "Live metrics unavailable"
      : mode === "idle" && !measured.some((point) => point.rate > 0) ? (ghost ? "" : "Waiting for a request")
      : measured.length < 2 ? "Collecting samples…" : "";
    set("trend-state", message);
    $("plot").dataset.empty = String(!measured.length);
    canvas.setAttribute("aria-label", mode === "idle" ? "No decode activity in the last two minutes" +
      (ghost ? "; previous burst shown faded" : "") : "Live decode throughput over two minutes" +
      (data?.liveDecode != null ? ", now " + number.format(data.liveDecode) + " tokens per second" : ""));
    if (!surface) return;
    const { ctx, width, height } = surface;
    const inset = 3 * scale, floor = height - 1;
    const toX = (at) => inset + (1 - (end - at) / windowMs) * (width - 2 * inset);
    const toY = (rate) => floor - rate / max * Math.max(0, height - 24 * scale);

    // Request markers: where each generation started decoding.
    const starts = (memory?.markers ?? []).filter((marker) => marker.start >= end - windowMs && marker.start <= end)
      .sort((a, b) => a.start - b.start);
    ctx.strokeStyle = "rgba(244,245,240,.2)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4 * scale, 6 * scale]);
    for (const marker of starts) {
      const x = Math.round(toX(marker.start)) + .5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, floor); ctx.stroke();
    }
    ctx.setLineDash([]);
    const signature = JSON.stringify([Math.round(width), starts.map((m) => [m.start, m.name, m.tokens, m.seen === end])]);
    if (markers.dataset.signature !== signature) {
      markers.dataset.signature = signature;
      const labels = starts.map((marker) => {
        const live = marker.seen === end;
        const label = element("span", live ? marker.name + " started" : marker.name + " · ≥" + whole.format(marker.tokens) + " tok");
        label.dataset.active = String(live);
        const x = toX(marker.start);
        label.dataset.side = live || x < width * .25 ? "right" : "left";
        label.style.left = x + "px";
        return label;
      });
      markers.replaceChildren(...labels);
      // Flip labels that would leave the plot, then drop ones that collide; keep the newest.
      const frame = markers.getBoundingClientRect();
      let fence = Infinity;
      for (const label of labels.reverse()) {
        let box = label.getBoundingClientRect();
        if (box.right > frame.right + 1 && label.dataset.side === "right") {
          label.dataset.side = "left";
          box = label.getBoundingClientRect();
        }
        if (box.right > frame.right + 1 || box.left < frame.left - 1 || box.right > fence) label.hidden = true;
        else fence = box.left;
      }
    }

    if (ghost) {
      // A copy of the previous burst, faded, at its own pace (compressed if longer than a quarter of the window).
      const span = Math.max(1, ghost.end - ghost.start), room = (width - 2 * inset) * .25;
      const factor = Math.min(1, room / ((span / windowMs) * (width - 2 * inset)));
      const ghostMax = M.chartCeiling(ghost.peak ?? 0);
      const groups = traceGroups(ghost.points, (at) => inset + (at - ghost.start) / windowMs * (width - 2 * inset) * factor,
        (rate) => floor - rate / ghostMax * Math.max(0, height - 24 * scale));
      strokeTrace(ctx, groups, floor, { fill: false, dash: [6 * scale, 6 * scale], alpha: .35 });
      const label = element("span", "Last burst · " + (M.ago(end - ghost.end) ?? ""));
      label.dataset.side = "right";
      label.style.left = (inset + room * .5) + "px";
      label.style.top = "34%";
      markers.dataset.signature = "";
      markers.replaceChildren(label);
    }

    const groups = traceGroups(points, toX, toY);
    strokeTrace(ctx, groups, floor);
    if (mode === "idle" && measured.length) {
      // Flat zero line out to now.
      const firstIdle = measured.findLast((point, index) => point.rate > 0 && measured[index + 1]?.rate === 0);
      ctx.strokeStyle = chartAccent;
      ctx.globalAlpha = .55;
      ctx.lineWidth = 1.5 * scale;
      ctx.beginPath();
      ctx.moveTo(firstIdle ? toX(firstIdle.at) : ghost ? inset + (width - 2 * inset) * .25 : toX(measured[0].at), floor - .5);
      ctx.lineTo(toX(end), floor - .5);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const latest = groups.at(-1)?.at(-1);
    glow.hidden = !latest || state !== "Online";
    if (latest) {
      glow.style.left = latest.x + "px";
      glow.style.top = Math.min(latest.y, floor) + "px";
      glow.dataset.hollow = String(!(measured.at(-1)?.rate > 0));
    }
  }

  function drawPrefill(server) {
    const points = history.get(server?.address) ?? [];
    const surface = canvasContext($("prefill-plot"));
    const last = points.at(-1);
    const recent = points.findLast((p) => p.estimate != null || p.prefill != null);
    const value = $("prefill-value");
    if (last?.prefill != null) {
      value.replaceChildren(number.format(last.prefill) + " ", element("small", "tok/s"));
    } else if (last?.phase === "Measuring") {
      value.replaceChildren(element("small", "Measuring…"));
    } else if (recent) {
      value.replaceChildren("≈ " + number.format(recent.estimate ?? recent.prefill) + " ", element("small", "tok/s"));
      value.title = "Last measured prompt processing speed";
    } else {
      value.replaceChildren(last?.phase === "Unavailable" ? "—" : element("small", "Idle"));
    }
    if (!surface) return;
    const { ctx, width, height } = surface;
    const peak = Math.max(1, ...points.map((p) => Math.max(p.prefill ?? 0, p.estimate ?? 0)));
    const end = snapshot?.at ?? Date.now();
    const bar = Math.max(4 * scale, width * .012);
    // Canvas needs a resolved colour; --text is the hex the SDK sets.
    ctx.fillStyle = getComputedStyle(root).getPropertyValue("--text").trim() || "#f4f5f0";
    for (const point of points) {
      const rate = point.prefill ?? point.estimate;
      if (rate == null) continue;
      const x = 3 * scale + (1 - (end - point.at) / windowMs) * (width - 6 * scale);
      const h = Math.max(3 * scale, (height - 2 * scale) * rate / peak);
      ctx.globalAlpha = point.prefill != null ? .8 : .55;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x - bar, height - h, bar, h, 2.25 * scale);
      else ctx.rect(x - bar, height - h, bar, h);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ---- Live decode number ---------------------------------------------------
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
    set("decode-integer", rate === 0 ? "0" : integer?.value ?? "—");
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

  // ---- Overview --------------------------------------------------------------
  function workSummary(data, mode, server) {
    const chip = $("work-chip"), line = $("idle-line"), meta = $("idle-meta");
    let chipText = null, chipType = null, idle = null;
    if (mode === "generating") {
      const rows = M.generations(data);
      const row = rows[0];
      chipType = row.type;
      chipText = [row.name, row.tokens != null && whole.format(row.tokens) + " tokens",
        row.elapsed != null && seconds.format(row.elapsed) + " s", rows.length > 1 && "+" + (rows.length - 1) + " more"]
        .filter(Boolean).join(" · ");
    } else if (mode === "prefill") {
      const rows = M.prefills(data);
      const row = rows[0];
      chipType = data.models.find((model) => model.id === row.model)?.type;
      chipText = [row.name, "prefill " + (row.total ? format(row.done, whole) + " / " + format(row.total, whole) : ""),
        row.rate > 0 && tps(row.rate), rows.length > 1 && "+" + (rows.length - 1) + " more"].filter(Boolean).join(" · ");
    } else if (mode === "loading") {
      const model = data.models.find((candidate) => candidate.loading);
      chipType = model.type;
      chipText = ["Loading " + model.name, model.loadingElapsed != null && M.duration(model.loadingElapsed),
        model.loadingRemaining != null && "~" + M.duration(model.loadingRemaining) + " left"].filter(Boolean).join(" · ");
    } else if (mode === "queued") {
      chipText = format(data.queued) + " queued";
    } else if (mode === "idle") {
      const last = activity.get(server?.address)?.last;
      if (last?.rate != null) {
        idle = { line: ["Last burst ", element("b", tps(last.rate)), " avg"],
          meta: [last.model, M.ago((snapshot?.at ?? Date.now()) - last.end), format(data.queued) + " queued"].filter(Boolean).join(" · ") };
      } else {
        // Nothing observed by this view yet; oMLX's idle clock says when a model was last used.
        const recent = data.models.filter((model) => model.loaded && model.idleSeconds > 0)
          .sort((a, b) => a.idleSeconds - b.idleSeconds)[0];
        idle = { line: recent ? ["Last used ", element("b", recent.name)] : ["Waiting for a request"],
          meta: [recent && M.duration(recent.idleSeconds) + " ago", data.avgDecode != null && "session avg " + tps(data.avgDecode)]
            .filter(Boolean).join(" · ") };
      }
    }
    chip.hidden = !chipText;
    if (chipText) {
      set("chip-text", chipText);
      chip.title = chipText;
      const kind = M.glyphType(chipType);
      $("chip-use").setAttribute("href", "#g-" + kind);
      chip.dataset.glyph = kind;
    }
    line.hidden = meta.hidden = !idle;
    if (idle) {
      const signature = JSON.stringify(idle.line.map((part) => typeof part === "string" ? part : part.textContent));
      if (line.dataset.signature !== signature) {
        line.dataset.signature = signature;
        line.replaceChildren(...idle.line);
      }
      set(meta, idle.meta);
      meta.hidden = !idle.meta;
    }
  }

  function residentState(model) {
    if (model.loading) return { busy: true, text: ["Loading", model.loadingElapsed != null && M.duration(model.loadingElapsed),
      model.loadingRemaining != null && "~" + M.duration(model.loadingRemaining) + " left"] };
    if (model.generating) {
      const tokens = (model.generations ?? []).reduce((sum, row) => sum + (row.tokens ?? 0), 0);
      return { busy: true, text: ["Generating" + (model.generating > 1 ? " ×" + model.generating : ""), whole.format(tokens) + " tok"] };
    }
    if (model.prefilling?.length) {
      const row = model.prefilling[0];
      return { busy: true, progress: row.total > 0 && row.done != null ? row.done / row.total : null,
        text: ["Prefill", row.total ? format(row.done, whole) + " / " + format(row.total, whole) + " tok" : null,
          row.rate > 0 && tps(row.rate), row.eta != null && "~" + M.duration(row.eta) + " left"] };
    }
    if (model.queued) return { busy: true, text: [model.queued + " queued"] };
    if (model.active) return { busy: true, text: [model.active + " active"] };
    return { busy: false, text: [] };
  }

  function renderResidents(data) {
    const list = $("resident-list"), glyphs = $("resident-glyphs");
    const models = (data?.models ?? []).filter((model) => model.loaded || model.loading);
    set("resident-count", data?.loaded == null ? "" : format(data.loaded) + " loaded");
    const signature = JSON.stringify([root.dataset.layout, models.map((model) => [model.id, model.name, model.type, model.loading,
      model.pinned, model.actualBytes, model.estimatedBytes, model.idleTtl, model.idleSeconds, model.decode, model.active,
      model.queued, model.generations, model.prefilling, model.loadingElapsed])]);
    if (list.dataset.signature === signature) return;
    list.dataset.signature = signature;
    if (!models.length) {
      const message = data ? "No resident models. Load one from Models." : "Waiting for server";
      list.replaceChildren(element("p", message));
      glyphs.replaceChildren(element("p", message));
      return;
    }
    const rows = models.map((model) => {
      const state = residentState(model);
      const row = element("article", "", "resident");
      row.dataset.busy = String(state.busy);
      const label = M.typeLabel(model.type);
      row.append(glyph(model.type, label + " model"), element("strong", model.name, "resident-name"));
      row.lastChild.title = model.name;
      const side = element("div", "", "resident-side");
      const timer = M.countdown(model);
      const size = model.actualBytes ?? model.estimatedBytes;
      const sizeText = size == null ? null : (model.actualBytes == null ? "≈ " : "") + gib(size);
      if (model.generating && model.decode != null) side.append(element("strong", tps(model.decode)), element("small", sizeText ?? ""));
      else if (model.pinned) {
        const pin = icon("i-pin", "pin");
        pin.removeAttribute("aria-hidden");
        pin.setAttribute("role", "img");
        pin.setAttribute("aria-label", "Pinned");
        side.append(pin);
      } else if (timer) {
        const text = timer.expiring ? "Unloading now" : "Unloads in " + M.clock(timer.remaining);
        const svg = ring(timer.fraction ?? 1, 36, 14, "countdown", text);
        svg.dataset.expiring = String(timer.expiring);
        side.append(svg);
      }
      if (side.childNodes.length) row.append(side);
      const timerText = timer && !model.pinned ? (timer.expiring ? "unloading" : "unloads in " + M.clock(timer.remaining)) : null;
      const sub = state.busy ? [...state.text, !model.generating && sizeText] :
        [label, model.pinned ? "pinned" : "idle", timerText, sizeText];
      row.append(element("span", sub.filter(Boolean).join(" · "), "resident-sub"));
      row.dataset.side = String(side.childNodes.length > 0);
      if (state.progress != null) {
        const bar = element("progress");
        bar.max = 1;
        bar.value = state.progress;
        bar.setAttribute("aria-label", "Prompt tokens processed");
        row.append(bar);
      }
      return row;
    });
    const top = list.scrollTop;
    list.replaceChildren(...rows);
    list.scrollTop = top;

    // Compact placements: a row of glyphs with sizes.
    const room = root.dataset.layout === "narrow" ? 5 : 6;
    const shown = models.length > room ? models.slice(0, room - 1) : models;
    const items = shown.map((model) => {
      const item = element("li");
      item.dataset.busy = String(residentState(model).busy);
      const size = model.actualBytes ?? model.estimatedBytes;
      item.append(glyph(model.type, M.typeLabel(model.type) + " model"), element("span", model.name),
        element("b", size == null ? (model.loading ? "Loading" : "—") : format(M.gib(size))));
      item.title = model.name;
      return item;
    });
    if (shown.length < models.length) items.push(element("li", "+" + (models.length - shown.length) + " more", "more"));
    glyphs.replaceChildren(...items);
  }

  function renderMemory(data) {
    const memory = M.memorySegments(data);
    set("memory-total", memory.used == null ? "—" : format(M.gib(memory.used)));
    set("memory-limit", memory.used == null ? "" : memory.limit == null ? "GiB in use" : "GiB of " + gib(memory.limit) + " ceiling");
    set("memory-free", gib(memory.free));
    const pressure = data?.pressure;
    set("pressure", pressure ? "Pressure " + (pressure === "ok" ? "normal" : pressure) : "");
    $("pressure").dataset.level = pressure ?? "";
    const bar = $("memory-bar"), legend = $("memory-legend");
    const signature = JSON.stringify(memory);
    if (bar.dataset.signature === signature) return;
    bar.dataset.signature = signature;
    const parts = memory.segments.map((segment) => {
      const span = element("span");
      span.dataset.glyph = segment.glyph;
      span.dataset.shade = segment.shade;
      span.dataset.estimated = String(segment.estimated);
      setWidth(span, segment.portion);
      span.title = segment.name + " · " + (segment.estimated ? "≈ " : "") + gib(segment.bytes);
      return span;
    });
    if (memory.other) {
      const span = element("span");
      span.dataset.other = "";
      setWidth(span, memory.other.portion);
      span.title = "Other process memory · " + gib(memory.other.bytes);
      parts.push(span);
    }
    bar.replaceChildren(...parts);
    bar.setAttribute("aria-label", memory.used == null ? "Memory unavailable" : "Memory by resident model: " +
      memory.segments.map((segment) => segment.name + " " + gib(segment.bytes)).concat(memory.other ? ["other " + gib(memory.other.bytes)] : []).join(", "));
    const entries = memory.segments.map((segment) => {
      const item = element("li");
      const swatch = element("i");
      swatch.dataset.glyph = segment.glyph;
      swatch.dataset.shade = segment.shade;
      item.append(swatch, element("span", segment.name), element("b", (segment.estimated ? "≈" : "") + format(M.gib(segment.bytes))));
      item.title = segment.name;
      return item;
    });
    if (memory.other) {
      const item = element("li");
      item.append(element("i"), element("span", "Other"), element("b", format(M.gib(memory.other.bytes))));
      item.title = "Process memory not attributed to a model";
      entries.push(item);
    }
    legend.replaceChildren(...entries);
  }

  function renderStats(data, server) {
    set("avg-decode", format(data?.avgDecode));
    set("avg-prefill", format(data?.avgPrefill, compact));
    set("session-requests", format(data?.requests, compact));
    const total = data?.input == null || data.output == null ? null : data.input + data.output;
    set("session-tokens", total == null ? "" : "· " + compact.format(total) + " tokens");
    set("overview-cache", data?.hitRate == null ? "—" : format(data.hitRate) + "%");
    setRing($("cache-ring-small"), data?.hitRate == null ? null : data.hitRate / 100);
    const recorded = averages.get(server?.address) ?? [];
    $("decode-spark").firstElementChild.setAttribute("d", M.sparkPath(recorded.map((row) => row.decode), 72, 26));
    $("prefill-spark").firstElementChild.setAttribute("d", M.sparkPath(recorded.map((row) => row.prefill), 72, 26));
  }

  function renderOverview(data, server, state) {
    const mode = state === "Online" ? M.activityState(data) : data ? "unavailable" : "unavailable";
    $("decode-card").dataset.activity = mode;
    const idle = mode === "idle";
    $("idle-word").hidden = !idle;
    updateDecode(server?.address, idle ? 0 : data?.liveDecode, state === "Online");
    set("active", format(data?.active));
    set("queued", format(data?.queued));
    workSummary(data, state === "Online" ? mode : "unavailable", server);
    renderStats(data, server);
    renderMemory(data);
    renderResidents(data);
    drawTrend(server, state, data, mode);
    drawPrefill(server);
  }

  // ---- Models ---------------------------------------------------------------
  function modelMeta(model, data) {
    const parts = [];
    const label = M.typeLabel(model.type);
    const ctx = model.context ? compact.format(model.context) + " ctx" : null;
    if (model.loading) parts.push(["Loading", "on"], label, ctx);
    else if (model.generating) parts.push(["● Generating" + (model.decode > 0 ? " " + tps(model.decode) : ""), "on"], label, ctx);
    else if (model.prefilling?.length) parts.push(["● Prefill", "on"], label, ctx);
    else if (model.loaded) {
      const timer = M.countdown(model);
      parts.push("Loaded", label, ctx, model.distributed && "Distributed", model.pinned && ["Pinned", "on"],
        timer && (timer.expiring ? ["Unloading now", "warn"] : "unloads in " + M.clock(timer.remaining)));
    } else {
      parts.push("Unloaded", label, ctx, model.loadFit === true ? ["Fits now", "on"] : model.loadFit === false ? ["Needs room", "warn"] : null);
    }
    const node = element("span", "", "card-meta");
    parts.filter(Boolean).forEach((part, index) => {
      if (index) node.append(" · ");
      if (Array.isArray(part)) node.append(element("span", part[0], part[1]));
      else node.append(part);
    });
    node.title = node.textContent;
    return node;
  }

  function modelCard(model, data, enabled) {
    const card = element("li", "", "card");
    card.dataset.model = model.id;
    const state = model.loading ? "loading" : model.loaded ? "loaded" : "unloaded";
    const kind = M.glyphType(model.type);
    card.dataset.state = state;
    card.dataset.glyph = kind;
    card.dataset.busy = String(Boolean(model.loading || model.generating || model.prefilling?.length || model.active));
    const isSelected = state === "unloaded" && previewed?.address === selected && previewed.id === model.id;
    card.dataset.selected = String(isSelected);
    if (state === "unloaded") {
      const select = element("button", "", "card-select");
      select.type = "button";
      select.dataset.select = model.id;
      select.setAttribute("aria-pressed", String(isSelected));
      select.setAttribute("aria-label", "Preview memory if " + model.name + " loads");
      card.append(select);
    }
    const memory = model.actualBytes ?? model.estimatedBytes;
    const name = element("strong", model.name, "card-name");
    name.title = model.name;
    card.append(glyph(model.type, M.typeLabel(model.type) + " model"), name,
      element("strong", memory == null ? "—" : (model.actualBytes == null ? "≈ " : "") + gib(memory), "card-size"),
      modelMeta(model, data));
    if (enabled && model.controllable) {
      const operation = model.loaded ? "unload" : "load";
      const busy = action?.model === model.id && action.address === selected;
      const button = element("button", busy ? "Working" : model.loading ? "Loading" : operation === "load" ? "Load" : "Unload", "model-action");
      button.type = "button";
      button.dataset.action = operation;
      button.dataset.model = model.id;
      const blocked = operation === "load" && model.loadFit === false;
      button.disabled = Boolean(action) || model.loading || blocked;
      button.dataset.disabled = String(button.disabled);
      button.setAttribute("aria-label", (operation === "load" ? "Load " : "Unload ") + model.name +
        (blocked ? ". Insufficient memory headroom." : ""));
      card.append(button);
    }
    // Fit bar: a loaded model's share of the ceiling, or where an unloaded one would land.
    const fit = element("div", "", "fit");
    const limit = data?.limit > 0 ? data.limit : null;
    if (limit != null && memory != null) {
      if (state === "unloaded") {
        const preview = M.loadPreview(data, model);
        const used = element("span", "", "fit-used"), add = element("span", "", "fit-add");
        setWidth(used, preview.usedPortion);
        add.style.left = (preview.usedPortion ?? 0) * 100 + "%";
        setWidth(add, preview.addPortion);
        fit.dataset.fit = String(preview.fits ?? "unknown");
        fit.append(used, add);
      } else {
        const own = element("span", "", "fit-own");
        setWidth(own, memory / limit);
        fit.append(own);
      }
    }
    card.append(fit);
    return card;
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

  function renderPreview(data) {
    const inventory = data?.models ?? [];
    const target = previewed?.address === selected ? inventory.find((model) => model.id === previewed.id && !model.loaded && !model.loading) : null;
    if (previewed && !target) previewed = null;
    const preview = M.loadPreview(data, target);
    const bar = $("preview-bar");
    setWidth($("preview-used"), preview.usedPortion);
    setWidth($("preview-add"), target ? preview.addPortion : 0);
    bar.dataset.overflow = String(Boolean(target && preview.fits === false));
    bar.dataset.glyph = target ? M.glyphType(target.type) : "";
    bar.setAttribute("aria-label", preview.used == null ? "Memory unavailable" : "Memory in use " + gib(preview.used) +
      (preview.limit ? " of " + gib(preview.limit) : "") + (target ? "; " + target.name + " would add " + gib(preview.add) : ""));
    const inUse = $("preview-in-use");
    inUse.replaceChildren(element("b", gib(preview.used)), " in use");
    const note = $("preview-note");
    note.dataset.glyph = target ? M.glyphType(target.type) : "";
    note.dataset.fit = String(preview.fits);
    if (target) {
      note.replaceChildren(element("b", "+" + (preview.add == null ? "?" : gib(preview.add))), " if " + target.name + " loads · ",
        element("span", preview.fits === true ? "fits now" : preview.fits === false ? "needs room" : "fit unknown", "fit-word"));
    } else {
      note.replaceChildren(inventory.some((model) => !model.loaded && !model.loading) ? "Tap an unloaded model to preview its memory" : "");
    }
    set("preview-limit", preview.limit == null ? "No ceiling reported" : gib(preview.limit) + " ceiling");
    set("models-headroom", gib(data?.headroomBytes));
  }

  function renderModels(data, enabled) {
    const inventory = data?.models ?? [];
    const groups = {
      all: inventory,
      loaded: inventory.filter((model) => model.loaded || model.loading),
      unloaded: inventory.filter((model) => model.loaded === false && !model.loading),
    };
    const models = groups[modelFilter];
    for (const button of filters) button.setAttribute("aria-pressed", String(button.dataset.filter === modelFilter));
    for (const key of Object.keys(groups)) set("count-" + key, data ? String(groups[key].length) : "");
    renderPreview(data);
    const area = $("model-space");
    const columns = Number.parseInt(getComputedStyle(area).getPropertyValue("--model-columns"), 10) || 1;
    const gap = 10.5 * scale, minimum = (root.dataset.layout === "full" ? 96 : 76) * scale;
    const rows = Math.max(1, Math.min(3, Math.floor((area.clientHeight + gap) / (minimum + gap))));
    const perPage = columns * rows;
    const [start, end] = paginate("models", models.length, perPage, modelIndex);
    modelIndex = start;
    const list = $("model-list");
    const visible = models.slice(start, end);
    list.style.setProperty("--model-rows", String(rows));
    const signature = JSON.stringify([enabled, action, selected, previewed, rows, data?.limit, data?.poolBytes, data?.processBytes, visible]);
    if (list.dataset.signature !== signature) {
      list.dataset.signature = signature;
      list.replaceChildren(...visible.map((model) => modelCard(model, data, enabled)));
    }
    set("models-empty", data ? modelFilter === "unloaded" ? "Every model is loaded." :
      modelFilter === "loaded" ? "No models are loaded. Choose Unloaded to load one." : "No models found." : "Model data unavailable.");
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
      await host.command("model", command);
    } catch {
      if (action?.id !== id) return;
      action = null;
      actionMessage = { address: command.address, text: "Dashledge could not send the model action." };
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

  // ---- Usage ----------------------------------------------------------------
  let weekSignature;
  function renderWeek(week, data) {
    const grid = $("week-grid"), speeds = $("week-speeds");
    const heat = week?.days ? M.heatGrid(week, snapshot?.at ?? Date.now()) : null;
    const signature = JSON.stringify([selected, week === undefined ? "loading" : week === null ? "none" : Boolean(week.disabled), heat, week?.speeds, data?.models?.map((model) => [model.id, model.name, model.type])]);
    if (signature === weekSignature) return;
    weekSignature = signature;
    // undefined: the collector has not fetched it yet; null: the server did not provide it.
    if (!week?.days) {
      const text = week === undefined ? "Loading weekly history…" : week?.disabled ?
        "Usage history is turned off in oMLX settings." : "Weekly history unavailable";
      grid.replaceChildren(element("p", text, "empty-state"));
      speeds.replaceChildren(element("p", text, "empty-state"));
      return;
    }
    const cells = [];
    for (const day of heat.days) {
      const date = new Date(day.date + "T12:00:00Z");
      const label = element("small", day.today ? "Today" : date.toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" }));
      label.dataset.today = String(day.today);
      cells.push(label);
      for (const cell of day.cells) {
        const node = element("i");
        if (cell.level != null) node.dataset.level = cell.level;
        if (cell.future) node.dataset.future = "true";
        if (cell.current) node.dataset.current = "true";
        node.title = day.date + " " + String(cell.hour).padStart(2, "0") + ":00 · " +
          (cell.future ? "later today" : cell.count == null ? "unavailable" : whole.format(cell.count) + " tokens");
        cells.push(node);
      }
    }
    grid.style.gridTemplateRows = "repeat(" + Math.max(1, heat.days.length) + ", minmax(0, 1fr))";
    grid.replaceChildren(...cells);
    const top = week.speeds[0]?.rate || 1;
    const rows = week.speeds.map((entry) => {
      const model = data?.models?.find((candidate) => candidate.id === entry.name);
      const row = element("div", "", "speed-row");
      row.dataset.glyph = M.glyphType(model?.type);
      const name = element("strong", model?.name ?? entry.name);
      name.title = entry.name;
      const bar = element("div", "", "track");
      const fill = element("span");
      setWidth(fill, entry.rate / top);
      bar.append(fill);
      row.append(glyph(model?.type, M.typeLabel(model?.type) + " model"), name, element("b", number.format(entry.rate)), bar);
      return row;
    });
    speeds.replaceChildren(...(rows.length ? rows : [element("p", "No timed generations in the last 7 days", "empty-state")]));
  }

  function renderUsage(data) {
    renderWeek(data ? data.week : null, data);
    const total = data?.input == null || data.output == null ? null : data.input + data.output;
    set("tokens-total", format(total, compact));
    set("requests", format(data?.requests, compact));
    set("tokens-prompt", format(data?.input, compact));
    set("tokens-output", format(data?.output, compact));
    set("tokens-cached", format(data?.cached, compact));
    set("cache-hit", data?.hitRate == null ? "—" : format(data.hitRate) + "%");
    setRing($("cache-ring"), data?.hitRate == null ? null : data.hitRate / 100);
    $("cache-ring-svg").setAttribute("aria-label", data?.hitRate == null ? "Prompt cache hit unavailable" : "Prompt cache hit " + format(data.hitRate) + " percent");
    $("token-split").hidden = !(total > 0);
    if (total > 0) {
      setWidth($("split-prompt"), data.input / total);
      $("token-split").setAttribute("aria-label", "Prompt " + compact.format(data.input) + " tokens, output " + compact.format(data.output) + " tokens");
    }
  }

  // ---- Server picker ---------------------------------------------------------
  function showPicker(servers, stale) {
    const options = $("server-options");
    const pages = $("servers-pages");
    const row = 45 * scale;
    const free = options.clientHeight + (pages.hidden ? 0 : pages.offsetHeight + 9 * scale);
    const fits = (height) => Math.max(1, Math.floor((height + 6 * scale) / row));
    const room = fits(free);
    const perPage = servers.length > room ? fits(free - 48 * scale) : room;
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

  // ---- Frame -------------------------------------------------------------------
  function statusText(state, data) {
    if (state !== "Online") return state;
    const mode = M.activityState(data);
    const active = data?.active > 0 ? " · " + data.active + " active" : "";
    return mode === "generating" ? "Generating" + active : mode === "prefill" ? "Prefill" + active :
      mode === "loading" ? "Loading model" : mode === "queued" ? data.queued + " queued" :
      mode === "idle" ? "Idle" : mode === "active" ? "Online" + active : "Online";
  }

  function render() {
    measure();
    updateAction();
    const servers = snapshot?.servers ?? [];
    const server = servers.find(({ address }) => address === selected) ?? servers[0];
    if (server) selected = server.address;
    if (servers.length < 2) choosing = false;
    const stale = Boolean(snapshot && Date.now() - snapshot.at > staleAfter);
    const data = server?.last ?? (server?.at ? server : null);
    const state = !snapshot ? "Connecting" : stale ? "Stale" :
      server?.error ? data ? "Stale" : "Offline" : server ? "Online" : "Setup";
    set("status-text", statusText(state, data));
    $("status").title = $("status-text").textContent;
    $("status").dataset.state = state.toLowerCase();
    $("status").dataset.activity = state === "Online" ? M.activityState(data) : "";
    set("server-label", servers.length === 1 ? server.name : "");
    set("server-name", server?.name ?? "");
    $("server-toggle").hidden = servers.length < 2;
    $("server-toggle").setAttribute("aria-expanded", String(choosing));

    // This Mac's specs describe the server only when it runs on this Mac.
    const mac = snapshot?.mac;
    const local = server && M.isLoopback(server.address);
    const specs = local ? [mac?.chip, mac?.gpu && mac.gpu + "-core GPU", mac?.memory].filter(Boolean).join(" · ") : "";
    $("mac-specs").hidden = !specs;
    set("mac-specs", specs);
    $("mac-specs").title = local && mac?.model ? "This Mac · " + mac.model : "";

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
      data?.uptime != null && "Up " + M.duration(data.uptime), view === "usage" && data?.week?.days && "Server local time",
      data && "Updated " + time.format(data.at)].filter(Boolean);
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

  // Dashledge serves the collector snapshot as a declared output of this package.
  window.omlxWidgetSnapshot = (value) => {
    if (value?.schema !== 1 || !Array.isArray(value.servers) || snapshot?.at === value.at) return;
    const previousSnapshot = snapshot;
    snapshot = value;
    const addresses = new Set(value.servers.map(({ address }) => address));
    for (const store of [history, activity, averages]) {
      for (const address of store.keys()) if (!addresses.has(address) && !value.error) store.delete(address);
    }
    for (const server of value.servers) {
      if (server.error) continue;
      const at = server.at ?? value.at;
      const points = history.get(server.address) ?? [];
      const jobs = (server.models ?? []).flatMap(model => model.prefilling ?? []);
      const hasActivity = server.liveDecode != null || jobs.length > 0 || server.models?.some(model => model.generating > 0);
      const prior = previousSnapshot?.servers.find(s => s.address === server.address);
      const estimate = M.completedPrefillRate(prior, server);
      const live = jobs.length && jobs.every(job => job.rate > 0)
        ? jobs.reduce((sum, job) => sum + job.rate, 0) : null;
      points.push({ at, rate: server.liveDecode ?? null, prefill: live,
        estimate, phase: jobs.length ? "Measuring" : hasActivity ? "Idle" : "Unavailable" });
      history.set(server.address, points.filter((point) => point.at >= value.at - windowMs));
      // Bursts and request starts outlive the two-minute window.
      activity.set(server.address, M.trackActivity(activity.get(server.address), {
        at, rate: server.liveDecode ?? null, generations: M.generations(server),
      }, windowMs));
      // Session averages as this view saw them change.
      const recorded = averages.get(server.address) ?? [];
      const latest = recorded.at(-1);
      if (server.avgDecode != null && (!latest || latest.requests !== server.requests ||
          latest.decode !== server.avgDecode || latest.prefill !== server.avgPrefill)) {
        recorded.push({ requests: server.requests, decode: server.avgDecode, prefill: server.avgPrefill });
        averages.set(server.address, recorded.slice(-24));
      }
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
    const choice = event.target.closest(".card-select[data-select]");
    if (choice) {
      const id = choice.dataset.select;
      previewed = previewed?.id === id && previewed.address === selected ? null : { id, address: selected };
      render();
      return;
    }
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
    previewed = null;
    weekSignature = undefined;
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
  // The SDK updates --px-scale on resize too; read it once both listeners ran.
  window.addEventListener("resize", () => requestAnimationFrame(render));
  host?.subscribe(({ theme, instanceID, viewport: mode }) => {
    const identityChanged = instanceID !== instance;
    const viewportChanged = mode !== viewport;
    const paletteChanged = theme?.accent && theme.accent !== chartAccent;
    if (paletteChanged) chartAccent = theme.accent;
    instance = instanceID;
    viewport = mode;
    if (identityChanged || viewportChanged || paletteChanged) render();
  });
  render();
  refresh();
  setInterval(refresh, 500);
})();
