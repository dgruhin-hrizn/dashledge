// Pure helpers for the oMLX view: no DOM, no clock reads. widget.js renders
// what these return; tests load this file with node:vm.
(function (root) {
  "use strict";
  const GIB = 1024 ** 3;
  const finite = (value) => typeof value === "number" && Number.isFinite(value);

  // ---- Model types ----------------------------------------------------------
  // oMLX reports model_type (llm, vlm, embedding, reranker, audio_tts, audio_stt,
  // audio_sts) or an engine_type. Five glyphs cover them; anything else is a
  // language model, the server's default engine.
  function glyphType(type) {
    const value = String(type ?? "").toLowerCase();
    if (/rerank/.test(value)) return "reranker";
    if (/embed/.test(value)) return "embedding";
    if (/audio|tts|stt|sts|speech|whisper|asr/.test(value)) return "speech";
    if (/vlm|vision|(^|_)vl($|_)|image|ocr|multimodal/.test(value)) return "vision";
    return "language";
  }

  const labels = {
    llm: "LLM", vlm: "Vision", embedding: "Embedding", reranker: "Reranker",
    audio_tts: "Text to speech", audio_stt: "Speech to text", audio_sts: "Speech to speech",
  };
  function typeLabel(type) {
    const value = String(type ?? "").toLowerCase();
    if (labels[value]) return labels[value];
    const glyph = glyphType(value);
    return glyph === "language" ? (value && value !== "batched" ? value : "LLM")
      : glyph === "speech" ? "Speech" : labels[glyph] ?? glyph;
  }

  // ---- Formatting that does not depend on locale -----------------------------
  function gib(bytes) {
    return finite(bytes) ? bytes / GIB : null;
  }

  function clock(seconds) {
    if (!finite(seconds) || seconds < 0) return null;
    const total = Math.ceil(seconds);
    const hours = Math.floor(total / 3600), minutes = Math.floor(total / 60) % 60, rest = total % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return hours ? hours + ":" + pad(minutes) + ":" + pad(rest) : minutes + ":" + pad(rest);
  }

  function duration(seconds) {
    if (!finite(seconds) || seconds < 0) return null;
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days) return days + "d " + hours % 24 + "h";
    if (hours) return hours + "h " + minutes % 60 + "m";
    return minutes ? minutes + "m" : Math.floor(seconds) + "s";
  }

  function ago(milliseconds) {
    if (!finite(milliseconds)) return null;
    const seconds = Math.max(0, Math.round(milliseconds / 1000));
    if (seconds < 60) return seconds < 5 ? "just now" : seconds + " s ago";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + " min ago";
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? hours + " h ago" : Math.floor(hours / 24) + " d ago";
  }

  // ---- Layout ---------------------------------------------------------------
  // Sizes are authored for the 1920 × 540 reference canvas; --px-scale is the
  // factor a native frame was enlarged by. Divide it back out to choose a layout.
  function layoutFor(width, height, scale) {
    const factor = finite(scale) && scale > 0 ? scale : 1;
    const w = width / factor, h = height / factor;
    if (!(w > 0 && h > 0)) return "full";
    if (h < 400) return w >= 1400 ? "strip" : "short";
    if (w >= 1400) return "full";
    return w >= 700 ? "compact" : "narrow";
  }

  // ---- Activity -------------------------------------------------------------
  const busy = (model) => model.loading || model.generating > 0 || model.prefilling?.length > 0 ||
    model.active > 0 || model.queued > 0;

  function activityState(data) {
    if (!data) return "unavailable";
    const models = data.models ?? [];
    if (models.some((model) => model.generating > 0)) return "generating";
    if (models.some((model) => model.prefilling?.length)) return "prefill";
    if (models.some((model) => model.loading)) return "loading";
    if (data.queued > 0) return "queued";
    if (data.active > 0) return "active";
    if (data.liveDecode == null) return "unavailable";
    return "idle";
  }

  function generations(data) {
    return (data?.models ?? []).flatMap((model) => (model.generations ?? []).map((row) => ({
      model: model.id, name: model.name, type: model.type, ...row,
    }))).sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0));
  }

  function prefills(data) {
    return (data?.models ?? []).flatMap((model) => (model.prefilling ?? []).map((row) => ({
      model: model.id, name: model.name, ...row,
    })));
  }

  // Seconds until an idle, unpinned model is unloaded, as a share of its TTL.
  // oMLX reports remaining = ttl - idle, so ttl = idle + remaining.
  function countdown(model) {
    if (!model?.loaded || model.loading || model.pinned || !finite(model.idleTtl) || busy(model)) return null;
    const total = finite(model.idleSeconds) ? model.idleSeconds + model.idleTtl : null;
    return {
      remaining: model.idleTtl,
      total,
      fraction: total > 0 ? Math.min(1, model.idleTtl / total) : null,
      expiring: model.idleTtl <= 0,
    };
  }

  // ---- Memory ---------------------------------------------------------------
  // The collector's headroom is limit − max(model pool, process footprint);
  // use the same basis so the bars never disagree with "Fits now".
  function memoryBasis(data) {
    const values = [data?.poolBytes, data?.processBytes].filter(finite);
    return values.length ? Math.max(...values) : null;
  }

  function memorySegments(data) {
    const used = memoryBasis(data);
    const limit = finite(data?.limit) && data.limit > 0 ? data.limit : null;
    const resident = (data?.models ?? []).filter((model) => model.loaded && !model.loading)
      .map((model) => ({
        id: model.id, name: model.name, type: model.type, glyph: glyphType(model.type),
        bytes: finite(model.actualBytes) ? model.actualBytes : finite(model.estimatedBytes) ? model.estimatedBytes : null,
        estimated: !finite(model.actualBytes),
      })).filter((segment) => segment.bytes != null)
      .sort((a, b) => b.bytes - a.bytes);
    const shades = {};
    for (const segment of resident) segment.shade = shades[segment.glyph] = (shades[segment.glyph] ?? -1) + 1;
    const attributed = resident.reduce((sum, segment) => sum + segment.bytes, 0);
    const otherBytes = used == null ? 0 : Math.max(0, used - attributed);
    const scale = limit ?? Math.max(used ?? 0, attributed);
    const total = attributed + otherBytes;
    // Estimates can exceed the measured total; never draw past the track.
    const shrink = scale > 0 && total > scale ? scale / total : 1;
    for (const segment of resident) segment.portion = scale > 0 ? segment.bytes / scale * shrink : 0;
    return {
      used, limit,
      free: limit != null && used != null ? Math.max(0, limit - used) : null,
      usedPortion: limit != null && used != null ? Math.min(1, used / limit) : null,
      segments: resident,
      other: otherBytes > 0 ? { bytes: otherBytes, portion: scale > 0 ? otherBytes / scale * shrink : 0 } : null,
    };
  }

  // What loading a model would add on top of what is in use now.
  function loadPreview(data, model) {
    const used = memoryBasis(data);
    const limit = finite(data?.limit) && data.limit > 0 ? data.limit : null;
    const add = finite(model?.estimatedBytes) ? model.estimatedBytes : null;
    if (limit == null || used == null) return { used, limit, add, usedPortion: null, addPortion: null, fits: model?.loadFit ?? null };
    const usedPortion = Math.min(1, used / limit);
    return {
      used, limit, add, usedPortion,
      addPortion: add == null ? null : Math.min(1 - usedPortion, add / limit),
      overflow: add != null && used + add > limit,
      fits: model?.loadFit ?? (add == null ? null : used + add <= limit),
    };
  }

  // ---- Weekly heatmap ---------------------------------------------------------
  function heatLevel(count, max) {
    if (!finite(count)) return null;
    if (count <= 0 || !(max > 0)) return 0;
    return Math.min(4, Math.max(1, Math.ceil(4 * Math.sqrt(count / max))));
  }

  // The usage endpoint buckets hours in server local time and ends at the
  // server's next midnight, so its last day is the server's today. Mark the
  // current hour only when the server's clock agrees with that day.
  function serverNow(at, offsetMinutes) {
    const date = finite(offsetMinutes) ? new Date(at + offsetMinutes * 60000) : new Date(at);
    const utc = finite(offsetMinutes);
    const parts = utc ? [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours()]
      : [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours()];
    const pad = (n) => String(n).padStart(2, "0");
    return { date: parts[0] + "-" + pad(parts[1]) + "-" + pad(parts[2]), hour: parts[3] };
  }

  function heatGrid(week, at) {
    const days = Array.isArray(week?.days) ? week.days : [];
    const max = Math.max(0, ...days.flatMap((day) => day.tokens.filter(finite)));
    const now = finite(at) ? serverNow(at, week?.offsetMinutes) : null;
    const todayDate = now && days.at(-1)?.date === now.date ? now.date : null;
    return {
      max,
      todayKnown: todayDate != null,
      days: days.map((day) => {
        const today = day.date === todayDate;
        return {
          date: day.date,
          today,
          cells: day.tokens.map((count, hour) => ({
            hour, count,
            level: today && hour > now.hour ? null : heatLevel(count, max),
            future: today && hour > now.hour,
            current: today && hour === now.hour,
          })),
        };
      }),
    };
  }

  // ---- Bursts and request markers ------------------------------------------
  // A burst is a run of samples with a generation in flight. Markers record
  // when each generation started decoding (sample time − elapsed), keyed by
  // request id plus start so cluster rows sharing an id stay distinct.
  function emptyActivity() {
    return { current: null, last: null, markers: [] };
  }

  function trackActivity(memory, sample, windowMs) {
    const state = memory ?? emptyActivity();
    const rows = sample.generations ?? [];
    const markers = state.markers.filter((marker) => marker.start >= sample.at - windowMs - 60000);
    for (const row of rows) {
      if (!finite(row.elapsed)) continue;
      const start = sample.at - row.elapsed * 1000;
      const match = markers.find((marker) => marker.model === row.model &&
        (row.id == null || marker.id === row.id) && Math.abs(marker.start - start) < 2500);
      if (match) {
        match.tokens = Math.max(match.tokens ?? 0, row.tokens ?? 0);
        match.seen = sample.at;
      } else {
        markers.push({ id: row.id ?? null, model: row.model, name: row.name, start: Math.round(start), tokens: row.tokens ?? 0, seen: sample.at });
      }
    }
    let current = state.current, last = state.last;
    const generating = rows.length > 0 || sample.rate > 0;
    if (generating) {
      current = current ? { ...current, points: current.points.concat({ at: sample.at, rate: sample.rate }) }
        : { start: sample.at, points: [{ at: sample.at, rate: sample.rate }], tokens: {} };
      for (const row of rows) {
        const name = row.name ?? row.model;
        current.tokens[name] = Math.max(current.tokens[name] ?? 0, row.tokens ?? 0);
      }
    } else if (current) {
      last = finishBurst(current);
      current = null;
    }
    return { current, last, markers };
  }

  function finishBurst(burst) {
    const rates = burst.points.map((point) => point.rate).filter((rate) => finite(rate) && rate > 0);
    const names = Object.entries(burst.tokens).sort((a, b) => b[1] - a[1]);
    return {
      start: burst.start,
      end: burst.points.at(-1).at,
      rate: rates.length ? rates.reduce((sum, rate) => sum + rate, 0) / rates.length : null,
      peak: rates.length ? Math.max(...rates) : null,
      model: names[0]?.[0] ?? null,
      points: burst.points,
    };
  }

  // ---- Charts ----------------------------------------------------------------
  function sparkPath(values, width, height, pad = 2) {
    const points = values.filter(finite);
    if (points.length < 2) return "";
    const low = Math.min(...points), high = Math.max(...points);
    const span = high - low || 1;
    return points.map((value, index) => {
      const x = pad + (width - 2 * pad) * index / (points.length - 1);
      const y = high === low ? height / 2 : height - pad - (height - 2 * pad) * (value - low) / span;
      return (index ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
    }).join(" ");
  }

  // Ceiling for the decode chart's y axis: a round step above the highest sample.
  function chartCeiling(high) {
    const step = high > 100 ? 50 : high > 20 ? 10 : 5;
    return Math.max(step, Math.ceil(Math.max(0, high) / step) * step);
  }

  // oMLX rounds its cumulative rate to 0.1 tok/s. Reject duration deltas
  // whose rounding uncertainty exceeds 10% of the inferred interval.
  function completedPrefillRate(before, after) {
    if (!before || before.error || after.error || after.requests <= before.requests ||
        !(after.at > before.at && after.at - before.at <= 3500) ||
        !(after.uptime >= before.uptime) || !(after.avgPrefill > 0)) return null;
    if (![before.input, before.cached, after.input, after.cached, before.requests, after.requests,
      before.uptime, after.uptime].every(Number.isFinite) ||
        before.input > after.input || before.cached > after.cached) return null;
    const oldTokens = before.input - before.cached, tokens = after.input - after.cached;
    if (oldTokens < 0 || tokens <= oldTokens || (oldTokens && !(before.avgPrefill > 0))) return null;
    const oldSeconds = oldTokens ? oldTokens / before.avgPrefill : 0;
    const seconds = tokens / after.avgPrefill - oldSeconds;
    const error = tokens / after.avgPrefill * .05 / (after.avgPrefill - .05) +
      (oldTokens ? oldSeconds * .05 / (before.avgPrefill - .05) : 0);
    return seconds > 0 && error <= .1 * seconds ? (tokens - oldTokens) / seconds : null;
  }

  function isLoopback(address) {
    try {
      const host = new URL(address).hostname.replace(/^\[|\]$/g, "");
      return host === "localhost" || host === "::1" || /^127\./.test(host);
    } catch {
      return false;
    }
  }

  root.omlxModel = {
    glyphType, typeLabel, gib, clock, duration, ago, layoutFor, activityState, generations, prefills,
    countdown, memoryBasis, memorySegments, loadPreview, heatLevel, serverNow, heatGrid, emptyActivity,
    trackActivity, finishBurst, sparkPath, chartCeiling, completedPrefillRate, isLoopback,
  };
})(globalThis);
