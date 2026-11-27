// Runs first in every package connector's JavaScriptCore context. It builds the
// web-style API connectors use (fetch, WebSocket, timers, console) and the
// `dashledge` object (connection, emit, storage) on the one raw host call, then
// removes that call from the global scope.
(() => {
  const host = globalThis.__host;
  delete globalThis.__host;
  const call = (op, args) => {
    const reply = JSON.parse(host(op, JSON.stringify(args ?? {})));
    if (reply.error) throw new Error(reply.error);
    return reply.ok;
  };
  let next = 1;
  const fetches = new Map(), timers = new Map(), sockets = new Map();

  // Bytes cross the host call as base64. The context has no TextEncoder or atob.
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const LOOKUP = new Uint8Array(128);
  for (let i = 0; i < 64; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;
  const toBase64 = bytes => {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
      out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + (i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? ALPHABET[n & 63] : '=');
    }
    return out;
  };
  const fromBase64 = text => {
    const clean = String(text).replace(/[^A-Za-z0-9+/]/g, '');
    const bytes = new Uint8Array(Math.floor(clean.length * 3 / 4));
    let j = 0;
    for (let i = 0; i < clean.length; i += 4) {
      const c = k => (i + k < clean.length ? LOOKUP[clean.charCodeAt(i + k)] : 0);
      const n = (c(0) << 18) | (c(1) << 12) | (c(2) << 6) | c(3);
      for (const shift of [16, 8, 0]) if (j < bytes.length) bytes[j++] = (n >> shift) & 255;
    }
    return bytes;
  };
  const encodeText = text => {
    const bytes = [];
    for (const ch of String(text)) {
      const c = ch.codePointAt(0);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(bytes);
  };
  // Invalid sequences become U+FFFD, as TextDecoder does.
  const decodeText = bytes => {
    let out = '', units = [];
    const flush = () => { out += String.fromCharCode.apply(null, units); units = []; };
    for (let i = 0; i < bytes.length;) {
      const b = bytes[i], need = b < 0x80 ? 0 : b >= 0xf0 && b < 0xf5 ? 3 : b >= 0xe0 ? 2 : b >= 0xc2 && b < 0xe0 ? 1 : -1;
      let c = need === 0 ? b : need > 0 ? b & (0x3f >> need) : -1;
      for (let k = 1; c >= 0 && k <= need; k++) {
        const next = bytes[i + k];
        c = next !== undefined && (next & 0xc0) === 0x80 ? (c << 6) | (next & 63) : -1;
      }
      if (c < 0 || c > 0x10ffff || (need === 2 && c < 0x800) || (need === 3 && c < 0x10000) || (c >= 0xd800 && c < 0xe000)) { units.push(0xfffd); i++; }
      else { if (c >= 0x10000) units.push(0xd800 + ((c - 0x10000) >> 10), 0xdc00 + ((c - 0x10000) & 1023)); else units.push(c); i += need + 1; }
      if (units.length > 8192) flush();
    }
    flush();
    return out;
  };
  const bytesOf = value => value instanceof ArrayBuffer ? new Uint8Array(value)
    : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null;

  class Response {
    constructor(r) {
      this.status = r.status;
      this.ok = r.status >= 200 && r.status < 300;
      const headers = r.headers || {};
      this.headers = {get: name => headers[String(name).toLowerCase()] ?? null};
      // A UTF-8 body arrives as text, anything else as base64.
      this._text = r.base64 == null ? r.body ?? '' : null;
      this._base64 = r.base64 ?? null;
    }
    async text() { return this._text ?? decodeText(fromBase64(this._base64)); }
    async json() { return JSON.parse(await this.text()); }
    async arrayBuffer() { return (this._text == null ? fromBase64(this._base64) : encodeText(this._text)).buffer; }
  }
  globalThis.fetch = (url, init = {}) => new Promise((resolve, reject) => {
    const id = next++;
    try {
      const headers = init.headers && typeof init.headers === 'object' ? {...init.headers} : {};
      const bytes = init.body == null ? null : bytesOf(init.body);
      const connection = Number.isInteger(init.connection) ? {connection: init.connection} : {};
      call('fetch', {id, url: String(url), method: init.method || 'GET', headers, ...connection,
        ...(bytes ? {bodyBase64: toBase64(bytes)} : {body: init.body == null ? undefined : String(init.body)})});
      fetches.set(id, {resolve, reject});
    } catch (error) { reject(error); }
  });

  const timer = repeat => (fn, ms = 0, ...args) => {
    const id = next++;
    timers.set(id, {fn: () => fn(...args), repeat});
    call('timer', {id, ms: Math.max(0, Number(ms) || 0), repeat});
    return id;
  };
  globalThis.setTimeout = timer(false);
  globalThis.setInterval = timer(true);
  globalThis.clearTimeout = globalThis.clearInterval = id => { timers.delete(id); call('clearTimer', {id}); };
  globalThis.queueMicrotask = fn => { Promise.resolve().then(fn); };

  class WebSocket {
    constructor(url) {
      this.id = next++;
      this.url = String(url);
      this.readyState = WebSocket.CONNECTING;
      this.binaryType = 'arraybuffer';
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      sockets.set(this.id, this);
      call('wsOpen', {id: this.id, url: this.url});
    }
    send(data) {
      if (this.readyState !== WebSocket.OPEN) throw new Error('WebSocket is not open');
      const bytes = bytesOf(data);
      call('wsSend', bytes ? {id: this.id, base64: toBase64(bytes)} : {id: this.id, text: String(data)});
    }
    close() {
      if (this.readyState >= WebSocket.CLOSING) return;
      this.readyState = WebSocket.CLOSING;
      call('wsClose', {id: this.id});
    }
  }
  Object.assign(WebSocket, {CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3});
  globalThis.WebSocket = WebSocket;

  const log = level => (...parts) => call('log', {level, message: parts.map(p => typeof p === 'string' ? p : p instanceof Error ? String(p) : JSON.stringify(p)).join(' ')});
  globalThis.console = {log: log('log'), info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug')};
  const storage = Object.freeze({get: key => call('storageGet', {key}), set: (key, value) => call('storageSet', {key, value})});

  globalThis.__dashledge_start = config => {
    const connections = Object.freeze((config.connections || []).map(c => Object.freeze({...c})));
    globalThis.dashledge = Object.freeze({
      // The placement's chosen connection, and every one it holds (that one first).
      connection: connections[0] ?? null,
      connections,
      emit: data => call('emit', {data}),
      storage,
    });
    delete globalThis.__dashledge_start;
  };
  globalThis.__dashledge_dispatch = event => {
    if (event.type === 'fetch') {
      const waiting = fetches.get(event.id);
      if (!waiting) return;
      fetches.delete(event.id);
      if (event.error) waiting.reject(new Error(event.error));
      else waiting.resolve(new Response(event.response));
    } else if (event.type === 'timer') {
      const t = timers.get(event.id);
      if (!t) return;
      if (!t.repeat) timers.delete(event.id);
      t.fn();
    } else if (event.type === 'socket') {
      const socket = sockets.get(event.id);
      if (!socket) return;
      if (event.event === 'open') { socket.readyState = WebSocket.OPEN; socket.onopen?.({type: 'open'}); }
      else if (event.event === 'message') socket.onmessage?.({type: 'message', data: event.data});
      else if (event.event === 'binary') socket.onmessage?.({type: 'message', data: fromBase64(event.data).buffer});
      else if (event.event === 'error') socket.onerror?.({type: 'error', message: event.data});
      else if (event.event === 'close' && socket.readyState !== WebSocket.CLOSED) {
        socket.readyState = WebSocket.CLOSED;
        sockets.delete(event.id);
        socket.onclose?.({type: 'close', code: Number(event.data) || 1006});
      }
    }
  };
})();
