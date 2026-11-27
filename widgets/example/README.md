# Build a Dashledge widget package

This ZIP is a working package: a weather widget that shows current conditions and today's temperatures from Open-Meteo. Install it as it is from **Widget Studio → Install package**, then add **Weather (example)** to a page. Edit the files to make your own widget.

## What's in a package

| File | Purpose |
| --- | --- |
| `widget.json` | The manifest: identity, view, connections, and where the widget's data comes from. |
| `index.html`, `view.js`, `style.css` | The view, shown on the Edge in a sandboxed frame. |
| `connector.js` | Optional. JavaScript that fetches and prepares data, run sandboxed by Dashledge. |
| `icon.svg` or `icon.png` | Square icon, up to 256 KiB. |
| `samples/declarative.widget.json` | A manifest for a widget that needs no connector code. |
| `dashledge.d.ts` | TypeScript declarations for the view and connector APIs. |

Compress the files into a ZIP with `widget.json` at the top level, or in a single folder. To update an installed widget, keep its `id`; its placements stay.

**Limits:** 8 MiB per package, 4 MiB per file, 256 files. Allowed file types: HTML, JS, CSS, JSON, images, fonts, text, licence and TypeScript source files. Dashledge runs only `.js`. No links or hidden files.

## Where the data comes from

Every view runs isolated. It can't reach the network, other widgets, Dashledge's settings, your files or your credentials. Data reaches it in one of three ways, and Widget Studio shows which before you install.

1. **Declarative.** The manifest lists `data` routes for Dashledge to poll and `actions` it may send. Dashledge makes the requests to the connection you choose, adding the credential you saved. No package code runs outside the view. See `samples/declarative.widget.json`.
2. **Connector.** `connector.js` runs in its own JavaScript context with no files, processes or modules. Its `fetch` and `WebSocket` reach only the connection's address and the `hosts` listed in the manifest; install shows those hosts. Dashledge adds the connection's credential itself, so connector code never sees it.
3. **Collector.** Node programs with full access to the Mac. Only widgets built into Dashledge use these. Installed packages that declare one are refused.

## widget.json

```json
{
  "apiVersion": 2,
  "id": "plugin.your-widget",
  "title": "Your widget",
  "description": "One line for Widget Studio.",
  "version": "1.0.0",
  "icon": "icon.svg",
  "view": {"entry": "index.html", "viewport": "native"},
  "sources": {"min": 1, "max": 1, "auth": "bearer", "test": ["api/status"],
              "addressLabel": "Server URL", "addressPlaceholder": "http://server.local/", "credentialLabel": "API token"},
  "displayName": {"serverField": "status.value.hostname"},
  "data": [{"id": "status", "path": "api/status", "every": 10}],
  "actions": [{"id": "restart", "method": "POST", "path": "api/services/{service}/restart", "body": {"service": "{service}"}}],
  "connector": {"entry": "connector.js", "hosts": ["https://api.example.com"], "storage": 65536},
  "permissions": ["settings", "keyboard", "ui", "mac.metrics"],
  "settings": [{"id": "units", "label": "Units", "type": "choice",
                "options": [{"value": "c", "label": "Celsius"}, {"value": "f", "label": "Fahrenheit"}]}]
}
```

- **`id`** starts with `plugin.` and uses lowercase letters, digits, `-` and `.`.
- **`view.theme`**: `true` when your view follows Dashledge's text and highlight colours (`state.theme`, also the CSS variables `--text` and `--accent`). Pages & layouts then lets each placement choose its own colours, and your view receives them in the same theme.
- **`view.viewport`**: `native` renders at the Edge's real size (2560 × 720) when the widget fills a page; `reference` uses the scaled 1920 × 540 canvas. Size type with `clamp()` and viewport units so the widget reads well in a narrow tile too.
- **`sources`** asks for connections. `auth` is `bearer`, `emby-token`, `pve-token` or `none`. `test` lists routes the Test button reads. Omit `sources` for a widget that needs no connection, like this example.
- **`displayName.serverField`** is a dot path into your data where the server reports its own name. Dashledge shows the name the user typed for the connection, else this, else the address's host.
- **`data`** routes are relative to the connection address, polled every 2–3600 seconds. They must return JSON.
- **`actions`** are `POST`, `PUT` or `DELETE` routes. `{name}` placeholders, in the route or as whole string values in `body`, take 1–128 letters, digits, `.`, `_`, `:` or `-` from the view.
- **`connector.hosts`** are bare origins such as `https://api.example.com`. `storage` is up to 1 MiB of key-value storage.
- **`permissions`** asks for Dashledge capabilities; see below. Install lists them, and an update marks new ones.
- **`settings`** (with the `settings` permission) declares up to 16 per-placement settings: `text` (`maxLength` up to 1024), `number` (`min`, `max`, `step`), `toggle`, `choice` (2–24 `options`), `multi` (several of 2–24 `options`; the value is a list, and `["*"]` means all), or `names` (`"for": "<a choice or multi setting>"`: the user's own name for each of its options, `maxLength` up to 128). Each has an `id`, a `label`, an optional `help` line and an optional `default`; Dashledge fills in a default when you leave it out. With the `settings.choices` permission, a `choice` or `multi` setting may be `"dynamic": true` instead of listing `options`: your view offers them at run time (see below).
- Unknown fields are refused, so a typo can't silently change what a widget may do.

## The view API: `window.Dashledge`

Dashledge injects this into every package view.

```js
Dashledge.subscribe(state => {
  // state.theme.primary and state.theme.accent follow the user's colours.
  // They are also set as the CSS variables --text and --accent.
});
Dashledge.onData(({rev, data, error}) => {
  // Connector: data is the last value passed to dashledge.emit().
  // Declarative: data.<id> is {value, at} or {error, at} for each poll.
  // error is set when the connector stopped.
});
Dashledge.displayName(serverName);          // the name to show for this placement's server
await Dashledge.action('restart', {service: 'web'}); // runs a declared action
```

Use ordinary buttons, links and scrolling containers. Dashledge replays touches from the Edge inside the view: taps, vertical and horizontal scrolling, and range sliders marked `data-edge-range`. A horizontal swipe turns the page when it starts at the bezel or when nothing under the finger can scroll sideways. Keep hit areas at least 44 × 44 CSS pixels.

Views can't use `fetch`, storage or nested frames. Load your own files with `<script>`, `<link>` and `<img>` only.

## Capabilities

Each capability works only when `permissions` declares it. Otherwise the call is refused.

```js
// settings: this placement's values, with defaults filled in. They also arrive in
// subscribe() state, and again whenever the user saves new ones.
Dashledge.settings.values.units;
await Dashledge.settings.open();   // the same editor as Pages & layouts; your gear can open it

// keyboard: Dashledge's touch keyboard, which also accepts typing. Resolves with the text or null.
const city = await Dashledge.keyboard.open({title: 'Choose a city', value: 'Lisbon', actionLabel: 'Search'});

// settings.choices: offer what you found for a dynamic setting, such as accounts,
// and look again when the user taps Check now in the placement's settings.
await Dashledge.settings.offer('accounts', [{value: 'work', label: 'Work account', detail: '72% left'}]);
Dashledge.settings.onRefresh(() => lookAgain());

// speech: say a line aloud in the user's Dashledge voice, while on screen.
const {spoken, reason} = await Dashledge.speech.say('Your export is ready');

// mac.metrics: this Mac's readings, about once a second.
Dashledge.mac.onMetrics(({cpu, gpu, memory, network, chip}) => { /* … */ });
```

- **settings** are per placement and reach only the view. A connector serves every placement on the same connection, so it doesn't see them.
- **settings.choices** offers up to 64 options per dynamic setting, each a `value` of 1–128 letters, digits or `._:@/-`, a `label` and an optional `detail`. Dashledge keeps the latest offer for each widget and connection, so the settings editor lists it even when no view is on screen. A saved value that isn't offered right now is kept and shown as not available, never dropped. Offer again only when the list changes.
- **keyboard** opens only while your widget is on screen, one sheet at a time, and always shows your widget's title.
- **ui** links Dashledge's `package-ui.css` before your styles. It provides `--dl-*` tokens and the classes `dl-surface`, `dl-panel`, `dl-caption`, `dl-reading` with `dl-unit`, `dl-list` with `dl-row`, `dl-button`, `dl-loading`, `dl-empty` and `dl-error`. Sizes follow `--px-scale`, so they keep their physical size at the native viewport.
- **reminders** is for bundled widgets only; an installed package that declares it is refused. It reads, checks off and adds Apple Reminders, and asks macOS for access, or changes a reminder, only while the widget is on screen. `onChange` reports changes made anywhere, and `voice` turns spoken reminders on or off, sets how early they're said and mutes Dashledge's voice.
- **speech** says one line (up to 500 characters) in the voice the user chose for Dashledge: a natural voice if they downloaded one in **Settings › General › Voice**, else the Mac's best installed voice. You don't choose the voice or volume. Nothing is said while Dashledge's voice is muted, during the user's quiet hours, or within a second of another widget's line; `say` then resolves with `{spoken: false, reason: 'muted' | 'quiet' | 'busy'}`. Only views on screen may speak, so keep anything important visible as well.
- **mac.metrics** reports CPU, per-core load, GPU, memory, network throughput, uptime and the chip name. It never includes the Mac's name, volumes or network interfaces.

## Develop with an unpacked folder

In **Widget Studio**, choose **Load unpacked package** and pick the folder that holds `widget.json`. Dashledge checks it like an install and runs it from that folder. When a file in it changes, open views reload and the connector restarts. After editing `widget.json`, choose **Reload** on the widget's page to pick up new settings or permissions. An unpacked folder takes the place of an installed package with the same ID. Removing it unlinks the folder and leaves your files where they are.

A connector widget's page has **Connector log**, with the last 50 lines it wrote with `console` and any error that stopped it.

For TypeScript, reference `dashledge.d.ts` and compile to JavaScript:

```ts
/// <reference path="./dashledge.d.ts" />
Dashledge.onData<{temperature: number}>(({data}) => render(data.temperature));
```

## The connector API

```js
dashledge.connection;               // {address, name} of the chosen connection, or null
const r = await fetch(url, {method, headers, body}); // r.ok, r.status, r.headers.get(), await r.json(), await r.text()
const socket = new WebSocket('wss://…'); // onopen, onmessage, onclose, onerror, send(), close()
setTimeout(fn, ms); setInterval(fn, ms); clearTimeout(id);
dashledge.storage.get(key); dashledge.storage.set(key, value); // persists across restarts
dashledge.emit(data);               // send JSON-compatible data (up to 1 MiB) to the view
console.log(...);                    // also info, warn, error and debug; shown in the connector log
```

Requests can't set `Authorization`, `Cookie`, `Host` or `X-Emby-Token`; Dashledge adds the connection's credential to requests for that connection only. Redirects aren't followed. Responses are limited to 8 MiB. A connector that runs for more than two seconds without returning is stopped, and the view receives the error.

## Legacy single-value widgets

API version 1 packages still install: a `widget.json` with `feed` (`mac` or `json`), a dot-path `field`, `view` (`number`, `trend` or `list`), `unit`, `accent` and a PNG `icon`.
