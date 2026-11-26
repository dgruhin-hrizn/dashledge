"use strict";
var EmberReferences = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // packages/agent/src/core/markdown/linkSpans.ts
  var linkSpans_exports = {};
  __export(linkSpans_exports, {
    LOCATIONS_MAX: () => LOCATIONS_MAX,
    linkSpans: () => linkSpans
  });

  // packages/agent/src/core/shell/locations.ts
  var LOC = /(?<![\w/.:@-])((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])?(?:[\w@.+~-]+[\\/])*[\w@+~-][\w@.+~-]*\.[A-Za-z][\w]{0,9})(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s?(\d+))?\))/g;
  var PY = /File "([^"]+)", line (\d+)/g;
  function lineLocations(line) {
    const out = [];
    for (const m of line.matchAll(PY)) out.push({ start: m.index, end: m.index + m[0].length, path: m[1], line: Number(m[2]) });
    for (const m of line.matchAll(LOC)) {
      const start = m.index;
      if (out.some((o) => start < o.end && o.start < start + m[0].length)) continue;
      const ln = Number(m[2] ?? m[4]);
      const col = m[3] ?? m[5];
      if (!ln) continue;
      out.push({ start, end: start + m[0].length, path: m[1], line: ln, ...col ? { col: Number(col) } : {} });
    }
    return out.sort((a, b) => a.start - b.start);
  }

  // packages/agent/src/core/markdown/paths.ts
  var PATH_REFS_MAX = 200;
  var PATH_MAX = 1024;
  var TOKEN = /[^\s"'`<>()[\]{}|,;]+/g;
  var TRAILING = /* @__PURE__ */ new Set([".", ",", ";", ":", "!", "?", "*"]);
  var EXT = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;
  var WIN_ABS = /^[A-Za-z]:[\\/]/;
  function kind(p) {
    if (p.includes("://") || /^[^\s/\\@]+@[^\s/\\@]+$/.test(p)) return void 0;
    if (!WIN_ABS.test(p) && /^[a-z][a-z0-9+.-]*:/i.test(p)) return void 0;
    if (WIN_ABS.test(p)) return p.length > 3 ? "abs" : void 0;
    if (/^~[\\/]./.test(p)) return "home";
    if (p.startsWith("/")) return /^\/+[^/]*[A-Za-z]/.test(p) ? "abs" : void 0;
    if (/^\.{1,2}[\\/]./.test(p)) return "rel";
    if (/[\\/]/.test(p)) return EXT.test(p) && /[A-Za-z]/.test(p.split(/[\\/]/)[0]) ? "rel" : void 0;
    const m = /^([\w@+-][\w@.+-]*)(\.[A-Za-z][A-Za-z0-9]{0,9})$/.exec(p);
    if (!m) return void 0;
    return m[1].length >= 2 || m[2].length >= 3 ? "bare" : void 0;
  }
  function findPathRefs(text) {
    const out = [];
    for (const m of text.matchAll(TOKEN)) {
      if (out.length >= PATH_REFS_MAX) break;
      if (m[0].length > PATH_MAX) continue;
      let end = m[0].length;
      while (end > 0 && TRAILING.has(m[0][end - 1])) end--;
      const t = m[0].slice(0, end);
      if (!t) continue;
      const at = /^(.+?):(\d+)(?::(\d+))?$/.exec(t);
      const path = at && !/^[A-Za-z]$/.test(at[1]) ? at[1] : t;
      const k = kind(path);
      if (!k) continue;
      const line = at && path !== t ? Number(at[2]) : void 0;
      const col = at && path !== t && at[3] ? Number(at[3]) : void 0;
      out.push({ start: m.index, end: m.index + t.length, path, ...line ? { line } : {}, ...col ? { col } : {}, bare: k === "bare" });
    }
    return out;
  }

  // packages/agent/src/core/markdown/urls.ts
  var URL_MAX = 2e3;
  var HIDDEN = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/;
  var CANDIDATE = /(?<![A-Za-z0-9+.-])(?:https?:\/\/|mailto:)[^\s\x00-\x1f\x7f"'`<>…​-‏‪-‮⁠-⁤⁦-⁩﻿]+/gi;
  var TRAILING2 = /* @__PURE__ */ new Set([".", ",", ";", ":", "!", "?", "*", "_", "~"]);
  var CLOSERS = { ")": "(", "]": "[", "}": "{" };
  function trimEnd(url) {
    const n = { "(": 0, "[": 0, "{": 0, ")": 0, "]": 0, "}": 0 };
    for (const c of url) if (c in n) n[c]++;
    let end = url.length;
    while (end > 0) {
      const last = url[end - 1];
      const opener = CLOSERS[last];
      if (TRAILING2.has(last)) end--;
      else if (opener && n[last] > n[opener]) {
        n[last]--;
        end--;
      } else break;
    }
    return url.slice(0, end);
  }
  function plausible(url) {
    if (/^mailto:/i.test(url)) return /^mailto:[^@\s?&]+@[^@\s.?&]+(?:\.[^@\s.?&]+)*(?:\?(?:subject|body)=[^&]*(?:&(?:subject|body)=[^&]*)*)?$/i.test(url);
    return /^https?:\/\/[A-Za-z0-9[]/i.test(url);
  }
  function findUrls(text) {
    const out = [];
    for (const m of text.matchAll(CANDIDATE)) {
      if (m[0].length > URL_MAX * 2) continue;
      if (HIDDEN.test(text.charAt(m.index + m[0].length))) continue;
      const url = trimEnd(m[0]);
      if (url.length > URL_MAX || !plausible(url)) continue;
      out.push({ start: m.index, end: m.index + url.length, url });
    }
    return out;
  }
  function urlParts(text) {
    const out = [];
    let at = 0;
    for (const u of findUrls(text)) {
      if (u.start > at) out.push({ start: at, text: text.slice(at, u.start) });
      out.push({ start: u.start, text: u.url, url: u.url });
      at = u.end;
    }
    if (at < text.length) out.push({ start: at, text: text.slice(at) });
    return out;
  }

  // packages/agent/src/core/markdown/linkSpans.ts
  var LOCATIONS_MAX = 1e3;
  function linkSpans(text, o = {}) {
    const out = [];
    let refs = 0;
    let locs = 0;
    const paths = (t, at) => {
      if (o.paths === false || refs >= PATH_REFS_MAX) return;
      for (const r of findPathRefs(t).slice(0, PATH_REFS_MAX - refs)) {
        out.push({ start: at + r.start, end: at + r.end, kind: "path", ref: { ...r, start: at + r.start, end: at + r.end } });
        refs++;
      }
    };
    for (const part of urlParts(text)) {
      if (part.url) {
        out.push({ start: part.start, end: part.start + part.text.length, kind: "url", url: part.url });
        continue;
      }
      if (!o.locations) {
        paths(part.text, part.start);
        continue;
      }
      let lineAt = part.start;
      for (const line of part.text.split("\n")) {
        let at = 0;
        for (const l of locs < LOCATIONS_MAX ? lineLocations(line) : []) {
          if (locs >= LOCATIONS_MAX) break;
          if (l.start > at) paths(line.slice(at, l.start), lineAt + at);
          out.push({ start: lineAt + l.start, end: lineAt + l.end, kind: "loc", path: l.path, ...l.line ? { line: l.line } : {}, ...l.col ? { col: l.col } : {} });
          locs++;
          at = l.end;
        }
        if (at < line.length) paths(line.slice(at), lineAt + at);
        lineAt += line.length + 1;
      }
    }
    return out;
  }
  return __toCommonJS(linkSpans_exports);
})();
