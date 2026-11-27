# Build a Dashledge widget package

This ZIP is a working package: a weather widget that shows current conditions and today's temperatures from Open-Meteo. Install it as it is from **Widget Studio → Install package**, then add **Weather (example)** to a page. Edit the files to make your own widget.

This file is the reference for the manifest and the APIs. For a step-by-step walkthrough, see "Build widgets for Dashledge" in the `widgets` folder of the Dashledge repository on GitHub (github.com/dgruhin-hrizn/dashledge).

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
2. **Connector.** `connector.js` runs in its own JavaScript context with no files, processes or modules. Its `fetch` and `WebSocket` reach only the connection's address and the `hosts` listed in the manifest; install shows those hosts. Dashledge adds the connection's credential itself, so connector code never sees it. A manifest with a connector runs no `data` polls: the view receives what the connector emits. `actions`, `images` and `streams` still work beside it.
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
- **`sources`** asks for connections. `test` lists routes the Test button reads. Omit `sources` for a widget that needs no connection, like this example. `auth` says how Dashledge sends the saved credential to the connection, and only to it:

  | `auth` | Sends | For example |
  | --- | --- | --- |
  | `"bearer"` | `Authorization: Bearer <key>` | Home Assistant, Unraid |
  | `{"header": "X-Api-Key"}` | `X-Api-Key: <key>` | Radarr, Sonarr, Prowlarr |
  | `{"header": "Authorization", "format": "MediaBrowser Token=\"{key}\""}` | the format, with `{key}` (and `{user}`) filled in | Jellyfin |
  | `{"query": "apikey"}` | `?apikey=<key>` on every request | SABnzbd |
  | `"basic"` | `Authorization: Basic` with the saved username and key | NZBGet |
  | `"emby-token"`, `"pve-token"` | `X-Emby-Token`, `Authorization: PVEAPIToken=` | Emby, Proxmox |
  | `{"login": …}` | signs in with the saved username and key, then sends the session | qBittorrent, Frigate (port 8971), Dispatcharr |
  | `"none"` | nothing | |

  A sign-in form names its route, body and fields, and where the session comes back:

  ```json
  "auth": {"login": {"path": "api/v2/auth/login", "fields": {"username": "{user}", "password": "{key}"}, "session": "cookie"}}
  "auth": {"login": {"path": "api/accounts/token/", "body": "json", "fields": {"username": "{user}", "password": "{key}"},
                     "session": {"token": "/access", "format": "Bearer {token}"}}}
  ```

  `body` is `form` (the default) or `json`. A `cookie` session sends back what the reply set. A `token` session reads the JSON pointer and sends it in `header` (default `Authorization`), shaped by `format`. Dashledge signs in when it first needs to, keeps the session in memory, signs in again once when the server answers 401 or 403, and waits 15 seconds after a refused sign-in. Test always signs in afresh.

  Add `"usernameLabel": "Username"` to ask for a username beside the key. One widget can talk to several products with `"types"`: each `{"id", "label"}` may bring its own `auth`, `test` and labels, the connection form asks which one, and your code reads it as `dashledge.connection.type` and `Dashledge.connectionType()`:

  ```json
  "sources": {"min": 1, "max": 1, "auth": "none", "types": [
    {"id": "sabnzbd", "label": "SABnzbd", "auth": {"query": "apikey"}, "test": ["api?mode=version&output=json"], "credentialLabel": "API key"},
    {"id": "nzbget", "label": "NZBGet", "auth": "basic", "test": ["jsonrpc/version"], "usernameLabel": "Username", "credentialLabel": "Password"}
  ]}
  ```

  Your code never sees the username, the key or a sign-in session:
  - A package can't set the credential's header.
  - Dashledge replaces any query parameter with the same name.
  - A credential the server echoes back, in a redirect's `Location` or in a response body, reaches your connector as `[credential]`.
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
Dashledge.connectionType();                 // the connection's type id from sources.types, or ''
await Dashledge.action('restart', {service: 'web'}); // runs a declared action
await Dashledge.command('pause', {minutes: 30});    // asks your connector (connector.commands)
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

// mac.metrics: this Mac's readings, about once a second.
Dashledge.mac.onMetrics(({cpu, gpu, memory, network, chip}) => { /* … */ });

// images: a poster or snapshot your manifest's `images` patterns allow.
poster.src = await Dashledge.image('api/v3/mediacover/12/poster-250.jpg');
snapshot.src = await Dashledge.image('api/front_door/latest.jpg?h=360', {fresh: true});

// stream: a WebSocket your manifest's `streams` declare, opened on the connection.
const live = await Dashledge.stream.open('live', {camera: 'front_door'});
live.onmessage = ({data}) => typeof data === 'string' ? handshake(data) : append(data);
```

- **settings** are per placement and reach only the view. A connector serves every placement on the same connection, so it doesn't see them.
- **settings.choices** offers up to 64 options per dynamic setting, each a `value` of 1–128 letters, digits or `._:@/-`, a `label` and an optional `detail`. Dashledge keeps the latest offer for each widget and connection, so the settings editor lists it even when no view is on screen. A saved value that isn't offered right now is kept and shown as not available, never dropped. Offer again only when the list changes.
- **keyboard** opens only while your widget is on screen, one sheet at a time, and always shows your widget's title.
- **ui** links Dashledge's `package-ui.css` before your styles. It provides `--dl-*` tokens and the classes `dl-surface`, `dl-panel`, `dl-caption`, `dl-reading` with `dl-unit`, `dl-list` with `dl-row`, `dl-button`, `dl-loading`, `dl-empty` and `dl-error`. Sizes follow `--px-scale`, so they keep their physical size at the native viewport.
- **reminders** is for bundled widgets only; an installed package that declares it is refused. It reads, checks off and adds Apple Reminders, and asks macOS for access, or changes a reminder, only while the widget is on screen. `onChange` reports changes made anywhere, and `voice` holds Dashledge’s spoken-reminder settings, one set for the whole app.
- **mac.metrics** reports CPU, per-core load, GPU, memory, network throughput, uptime and the chip name. It never includes the Mac's name, volumes or network interfaces.
- **images** needs `"images"` in the manifest: up to 16 patterns, each a path under the connection's address or a full URL on a connector host, where `*` matches within one path segment. For example `["api/v3/mediacover/*/*.jpg", "https://image.tmdb.org/t/p/*/*"]`. Dashledge fetches the image (with the connection's credential only on the connection), accepts only JPEG, PNG, GIF and WebP, caches it for 10 minutes, and resolves with a `blob:` URL. A query such as `?h=360` may follow the path. Pass `{fresh: true}` for images that change, like camera snapshots. Paths are relative to the address, so strip a leading `/` and any URL base the server includes.
- **stream** needs `"streams"` in the manifest: up to 8 `{"id", "path"}` routes on the connection, with `{placeholders}` in the path or query, such as `{"id": "live", "path": "live/mse/api/ws?src={camera}"}` for Frigate. Dashledge opens them as `ws`/`wss` with the connection's credential and saved certificate, and a widget may keep 4 open. Text frames arrive as strings, binary frames as ArrayBuffers; `send()` takes text up to 64 KiB. Streams close when the widget leaves the screen. To play fMP4 video, attach a `MediaSource` with `video.srcObject = mediaSource`: a `blob:` media URL doesn't play in the widget's sandboxed frame. `samples/mse-player.js` does this for go2rtc.

### Live camera video (Frigate)

Frigate serves each camera through go2rtc as fragmented MP4 over a WebSocket (MSE). Declare the route and copy `samples/mse-player.js` into your view:

```json
"sources": {"min": 1, "max": 1, "auth": "none", "addressLabel": "Frigate URL", "addressPlaceholder": "http://frigate.local:5000/"},
"permissions": ["stream", "images"],
"streams": [{"id": "live", "path": "live/mse/api/ws?src={camera}"}],
"images": ["api/*/latest.jpg"]
```

```js
const player = playLive(document.querySelector('video'), 'live', {camera: 'front_door'},
  {onState: state => badge.textContent = state});   // connecting, live, reconnecting, paused, unavailable, unsupported
```

`playLive` offers go2rtc the codecs this Mac decodes, attaches the stream with `video.srcObject`, keeps about 10 seconds buffered near the live edge, reconnects with backoff, and pauses while the page is hidden. For a grid, show `Dashledge.image('api/<camera>/latest.jpg?h=360', {fresh: true})` snapshots and play live video only for the camera the user opens. A widget keeps at most 4 streams. go2rtc on its own port uses `api/ws?src={camera}`.

### Commands to your connector

Declare `"connector": {"entry": "connector.js", "commands": ["pause", "load-model"]}` and the view can ask the connector to act:

```js
// connector.js
dashledge.onCommand('pause', async ({minutes}) => {
  const r = await fetch(dashledge.connection.address + 'api?mode=pause&value=' + minutes, {method: 'POST'});
  return {ok: r.ok};
});
dashledge.onCommand('load-model', ({id}) => fetch(base + 'admin/api/models/' + id + '/load', {method: 'POST', timeout: 600}).then(r => r.ok));

// view
const result = await Dashledge.command('pause', {minutes: 30});
```

A command name is lowercase letters, digits, `-` or `_`, and `action`, `image` and `model` are reserved. The handler may return a value or a promise; a thrown error rejects the view's call. Requests that take longer than 15 seconds pass `timeout` (seconds, up to 600) to `fetch`.

### Several connections

With `"sources": {"min": 1, "max": 4}` a placement holds up to four connections: the one the user picked, then their other saved connections for your widget. A connector sees all of them in `dashledge.connections` (`dashledge.connection` is the first). Its `fetch` and `WebSocket` send each request with the credential of the connection whose address it falls under, so two services behind one reverse proxy (`/radarr/`, `/sonarr/`) keep their own keys. Pass `{connection: i}` to `fetch` to choose one explicitly. A view does the same with `Dashledge.action(id, args, {connection: i})`, `Dashledge.image(path, {connection: i})` and `Dashledge.stream.open(id, params, {connection: i})`. Declarative `data` polls read the first connection.

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
dashledge.connection;               // {address, name, type} of the chosen connection, or null
dashledge.connections;              // every connection the placement holds; connections[0] is dashledge.connection
const r = await fetch(url, {method, headers, body, timeout, connection});
                                     // r.ok, r.status, r.headers.get(), await r.json(), r.text(), r.arrayBuffer()
const socket = new WebSocket('wss://…'); // onopen, onmessage, onclose, onerror, send(), close()
dashledge.onCommand(name, handler); // answer Dashledge.command(name, args) from the view
setTimeout(fn, ms); setInterval(fn, ms); clearTimeout(id); clearInterval(id); queueMicrotask(fn);
dashledge.storage.get(key); dashledge.storage.set(key, value); // persists across restarts
dashledge.emit(data);               // send JSON-compatible data (up to 1 MiB) to the view
console.log(...);                    // also info, warn, error and debug; shown in the connector log
```

- **`connection.address`** is the resolved address, the same one Test uses. It ends in `/` (just the origin when the manifest sets `"address": "origin"`), so append relative paths: `address + 'api/status'`.
- **`fetch`** takes `GET`, `HEAD`, `POST`, `PUT`, `PATCH` and `DELETE`. `body` is a string, an `ArrayBuffer` or a typed array, up to 1 MiB. Requests time out after 15 seconds, and `timeout` asks for up to 600. `connection` picks a connection by index; otherwise Dashledge uses the one whose address the URL falls under.
- **`WebSocket`** messages arrive as strings or `ArrayBuffer`s, and `send()` takes either. A connector keeps up to 8 sockets open.
- **Requests can't set** `Authorization`, `Cookie`, `Host`, `X-Emby-Token`, `Proxy-Authorization`, `Content-Length` or the header your `auth` uses. Dashledge adds the connection's credential or session itself, to requests for that connection only. Set `Content-Type`, `Accept` and other headers as you need.
- **Redirects aren't followed. Responses are limited to 8 MiB.**
- **A connector that runs for more than two seconds without returning is stopped**, and the view receives the error. Waiting on `fetch` or a timer doesn't count.

## Legacy single-value widgets

API version 1 packages still install: a `widget.json` with `feed` (`mac` or `json`), a dot-path `field`, `view` (`number`, `trend` or `list`), `unit`, `accent` and a PNG `icon`.
