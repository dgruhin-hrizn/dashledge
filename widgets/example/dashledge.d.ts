// TypeScript declarations for Dashledge widget packages (API version 2).
//
// Views: reference this file from a view script with
//   /// <reference path="./dashledge.d.ts" />
// and use `Dashledge`. Connectors: the `DashledgeConnector` namespace below declares the
// globals a connector script sees; add `/// <reference lib="es2022" />` and
// `/// <reference path="./dashledge.d.ts" />` and use `dashledge`, `fetch`, `WebSocket`,
// the timers and `console`.
//
// Packages may carry .ts files, but Dashledge runs only .js: compile before packaging.

// ---------------------------------------------------------------- views ----

declare namespace DashledgeView {
  type Permission = 'settings' | 'keyboard' | 'ui' | 'mac.metrics';
  type SettingValue = string | number | boolean;

  interface Theme {
    mode: 'dark';
    /** The user's text colour; also set as `--text` on the root element. */
    primary: string;
    /** The user's highlight colour; also set as `--accent`. */
    accent: string;
  }

  interface State {
    /** A stable ID for this placement's view. */
    instanceID: string;
    touchMode: boolean;
    /** The name the user gave the connection, or '' for automatic. Prefer `Dashledge.displayName()`. */
    displayName: string;
    /** What the server reported at the manifest's `displayName.serverField`. */
    serverName: string;
    /** The connection address's host. */
    host: string;
    /** 'native' when the widget fills the display at its real size, else 'reference' (1920 × 540, scaled). */
    viewport: 'native' | 'reference';
    theme: Theme;
    /** The capabilities the manifest declares. */
    permissions: Permission[];
    /** This placement's settings, when the manifest declares `settings`. */
    settings?: Record<string, SettingValue>;
  }

  interface Data<T = unknown> {
    /** Increases with every new snapshot. */
    rev: number;
    /** Declarative packages: an object keyed by data poll ID. Connectors: whatever `dashledge.emit()` sent. */
    data: T;
    /** Why the last poll or connector step failed, else null. */
    error: string | null;
  }

  interface KeyboardOptions {
    /** Heading of the keyboard sheet. The sheet always names your widget too. */
    title?: string;
    /** Initial text. */
    value?: string;
    placeholder?: string;
    /** Label of the submit key, such as "Search" or "Rename". Defaults to "Done". */
    actionLabel?: string;
    /** 1–1024, default 256. */
    maxLength?: number;
  }

  /** The `mac.metrics` readings, about once a second. Values are null while unavailable. */
  interface MacMetrics {
    /** Milliseconds since the epoch. */
    at: number;
    /** Total CPU use, 0–100. */
    cpu: number | null;
    perCore: (number | null)[];
    cores: number | null;
    /** GPU use, 0–100. */
    gpu: number | null;
    /** Bytes. */
    memory: {used: number | null; total: number | null; swap: number | null};
    /** Bytes per second across Ethernet and Wi-Fi. */
    network: {rx: number | null; tx: number | null};
    /** Seconds since boot. */
    uptime: number | null;
    /** The processor's name, such as "Apple M4 Max". */
    chip: string | null;
  }

  interface API {
    /** Called now and whenever theme, names, viewport or settings change. Returns an unsubscribe function. */
    subscribe(callback: (state: State) => void): () => void;
    /** Data from the package's declarative polls or connector. Called with the latest snapshot right away when there is one. */
    onData<T = unknown>(callback: (data: Data<T>) => void): () => void;
    /** Run an action the manifest declares, filling its {placeholders} from `args`. */
    action(id: string, args?: Record<string, string | number | boolean>): Promise<{status: number}>;
    /** The name to show for this placement's server: the user's name, else the server's, else the host. */
    displayName(serverName?: string): string;
    /** Low-level: send a host command. Prefer the helpers. */
    command(name: string, args?: unknown): Promise<unknown>;

    /** Requires the `settings` permission. */
    settings: {
      /** This placement's values, with manifest defaults filled in. */
      readonly values: Record<string, SettingValue>;
      /** Open this placement's settings editor (the same one as Pages & layouts). Resolves with the saved values, or null if cancelled. */
      open(): Promise<Record<string, SettingValue> | null>;
    };
    /** Requires the `keyboard` permission. */
    keyboard: {
      /** Open the shared touch keyboard. Resolves with the text, or null when closed. Opens only while the widget is on screen. */
      open(options?: KeyboardOptions): Promise<string | null>;
    };
    /** Requires the `mac.metrics` permission. */
    mac: {
      /** The latest reading, or null before the first one. */
      metrics(): Promise<MacMetrics | null>;
      /** Called with each new reading. Returns an unsubscribe function. */
      onMetrics(callback: (metrics: MacMetrics) => void): () => void;
    };
  }
}

interface Window {
  Dashledge: DashledgeView.API;
  /** The same object as `Dashledge`, for views written against the Zurface API. */
  Zurface: DashledgeView.API;
}
declare var Dashledge: DashledgeView.API;

// ----------------------------------------------------------- connectors ----

declare namespace DashledgeConnector {
  interface Connection {
    /** The placement's connection address, as the user entered it. */
    address: string;
    /** The connection's name, or '' when automatic. */
    name: string;
  }

  interface Host {
    /** The placement's connection, or null when the package declares no sources. */
    readonly connection: Readonly<Connection> | null;
    /** Send data to every view of this connector. Views receive it through `Dashledge.onData`. */
    emit(data: unknown): void;
    /** A small per-package store that survives restarts (`connector.storage` bytes, default 64 KiB). */
    readonly storage: {
      get(key: string): unknown;
      set(key: string, value: unknown): void;
    };
  }

  /** The connector's `fetch`. It reaches only the connection's origin and the manifest's declared hosts; the stored credential is added for the connection; redirects are refused. */
  interface Response {
    readonly status: number;
    readonly ok: boolean;
    readonly headers: {get(name: string): string | null};
    text(): Promise<string>;
    json<T = unknown>(): Promise<T>;
  }
  interface RequestInit {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    headers?: Record<string, string>;
    body?: string;
  }

  /** Text-frame WebSocket to the connection or a declared host. Binary frames arrive base64-encoded. */
  class WebSocket {
    static readonly CONNECTING: 0;
    static readonly OPEN: 1;
    static readonly CLOSING: 2;
    static readonly CLOSED: 3;
    constructor(url: string);
    readonly url: string;
    readonly readyState: 0 | 1 | 2 | 3;
    onopen: ((event: {type: 'open'}) => void) | null;
    onmessage: ((event: {type: 'message'; data: string}) => void) | null;
    onclose: ((event: {type: 'close'; code: number}) => void) | null;
    onerror: ((event: {type: 'error'; message: string}) => void) | null;
    send(text: string): void;
    close(): void;
  }

  interface Globals {
    dashledge: Host;
    fetch(url: string, init?: RequestInit): Promise<Response>;
    WebSocket: typeof WebSocket;
    setTimeout(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): number;
    setInterval(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): number;
    clearTimeout(id: number): void;
    clearInterval(id: number): void;
    queueMicrotask(callback: () => void): void;
    /** Lines appear in Widget Studio's connector log (the last 50 per package). */
    console: Record<'log' | 'info' | 'warn' | 'error' | 'debug', (...parts: unknown[]) => void>;
  }
}
