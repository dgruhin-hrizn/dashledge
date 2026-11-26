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

  class Response {
    constructor(r) {
      this.status = r.status;
      this.ok = r.status >= 200 && r.status < 300;
      const headers = r.headers || {};
      this.headers = {get: name => headers[String(name).toLowerCase()] ?? null};
      this._body = r.body ?? '';
    }
    async text() { return this._body; }
    async json() { return JSON.parse(this._body); }
  }
  globalThis.fetch = (url, init = {}) => new Promise((resolve, reject) => {
    const id = next++;
    try {
      const headers = init.headers && typeof init.headers === 'object' ? {...init.headers} : {};
      call('fetch', {id, url: String(url), method: init.method || 'GET', headers,
        body: init.body == null ? undefined : String(init.body)});
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
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      sockets.set(this.id, this);
      call('wsOpen', {id: this.id, url: this.url});
    }
    send(text) {
      if (this.readyState !== WebSocket.OPEN) throw new Error('WebSocket is not open');
      call('wsSend', {id: this.id, text: String(text)});
    }
    close() {
      if (this.readyState >= WebSocket.CLOSING) return;
      this.readyState = WebSocket.CLOSING;
      call('wsClose', {id: this.id});
    }
  }
  Object.assign(WebSocket, {CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3});
  globalThis.WebSocket = WebSocket;

  const log = (...parts) => call('log', {message: parts.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join(' ')});
  globalThis.console = {log, info: log, warn: log, error: log, debug: log};
  const storage = Object.freeze({get: key => call('storageGet', {key}), set: (key, value) => call('storageSet', {key, value})});

  globalThis.__dashledge_start = config => {
    globalThis.dashledge = Object.freeze({
      connection: config.connection ? Object.freeze({...config.connection}) : null,
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
      else if (event.event === 'error') socket.onerror?.({type: 'error', message: event.data});
      else if (event.event === 'close' && socket.readyState !== WebSocket.CLOSED) {
        socket.readyState = WebSocket.CLOSED;
        sockets.delete(event.id);
        socket.onclose?.({type: 'close', code: Number(event.data) || 1006});
      }
    }
  };
})();
