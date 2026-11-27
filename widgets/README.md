# Build widgets for Dashledge

A Dashledge widget is a **plugin package**: a folder with a `widget.json` manifest, an HTML view, and optionally a small JavaScript connector. You don't need to build Dashledge or know Rust. You need the Dashledge app, a text editor, and the server or API your widget will show.

This guide walks through building, testing and sharing a plugin. The complete API reference is [`example/README.md`](example/README.md). It ships inside the example package as well, and [`example/dashledge.d.ts`](example/dashledge.d.ts) declares every API for TypeScript.

- [How a plugin works](#how-a-plugin-works)
- [Set up](#set-up)
- [Your first plugin in ten minutes](#your-first-plugin-in-ten-minutes)
- [Choose how your widget gets data](#choose-how-your-widget-gets-data)
- [Walkthrough: a download queue with posters](#walkthrough-a-download-queue-with-posters)
- [When you need a connector](#when-you-need-a-connector)
- [Connecting to real servers](#connecting-to-real-servers)
- [Artwork and live video](#artwork-and-live-video)
- [Designing for the Edge](#designing-for-the-edge)
- [Package, install, update and share](#package-install-update-and-share)
- [Troubleshooting](#troubleshooting)

## How a plugin works

```
            your server (Radarr, SABnzbd, Frigate, …)
                    ▲
                    │  Dashledge adds the saved credential,
                    │  only on that server's address
   ┌────────────────┴────────────────┐
   │ Dashledge (Rust)                │
   │  • polls your declared routes   │  or  ┌─────────────────────────┐
   │  • runs your actions            │◄────►│ connector.js (sandboxed)│
   │  • fetches declared images      │      │ fetch · WebSocket · emit│
   │  • relays declared streams      │      └─────────────────────────┘
   └────────────────┬────────────────┘
                    │  message bridge (window.Dashledge)
                    ▼
   ┌─────────────────────────────────┐
   │ your view (sandboxed iframe)    │
   │ index.html · view.js · style.css│
   └─────────────────────────────────┘
```

The user installs your package, adds a **connection** (the server's address and its API key, password or token), and places the widget on a page. Three rules shape everything you write:

1. **Your view is sandboxed.** It can't use `fetch`, storage or nested frames, and it can't reach Dashledge's settings or other widgets. Everything comes through `window.Dashledge`.
2. **Your code never sees the credential.** Dashledge stores it in the macOS Keychain and adds it to requests for that connection only. You declare *how* the server expects it, such as `X-Api-Key`, `?apikey=`, Basic or a sign-in form.
3. **The manifest is the contract.** Unknown fields are refused, and every capability, host, route and command must be declared. The install sheet shows the user what you declared before they confirm.

## Set up

1. Install Dashledge from the [releases page](https://github.com/dgruhin-hrizn/dashledge/releases/latest). It runs on Apple Silicon Macs, and you don't need a XENEON EDGE to develop: **Show Window Preview** opens the dashboard in a resizable window.
2. Open **Settings → Widget Studio** and choose **Download example**. You get a ZIP of a working package. Unzip it somewhere you keep code.
3. Optional: if you write TypeScript, add `/// <reference path="./dashledge.d.ts" />` at the top of your files and compile them to `.js`. Dashledge runs only JavaScript.

## Your first plugin in ten minutes

The example is a weather widget with a connector that reads Open-Meteo.

1. Open `widget.json` and change the `id` to your own, for example `plugin.my-weather`, and the `title`. The `id` is your widget's identity: placements and saved connections follow it, so choose it before you place the widget.
2. In **Widget Studio**, choose **Load unpacked package** and pick the folder. Dashledge checks it as if you'd installed it, then runs it straight from that folder.
3. In **Pages & layouts**, add a page and choose **Add widget**, then your widget. Watch it in **Live preview** or the window preview. When you change `widget.json` later, choose **Reload** on the widget's page in Widget Studio. Other files reload by themselves.
4. In `connector.js`, change `PLACE` to your city and save. The connector restarts and the view updates.
5. Add `console.log('reading', reading)` before `dashledge.emit(...)` and save. Open the widget's page in Widget Studio. **Connector log** shows the last 50 lines and any error that stopped the connector.
6. In `view.js` and `style.css`, change what's shown. Open views reload when you save.

That loop is all of development: edit, save, look. When you're happy, [package it](#package-install-update-and-share).

## Choose how your widget gets data

| You need | Use | Package code that runs outside the view |
| --- | --- | --- |
| JSON from a server on a timer, plus a few buttons that POST | **Declarative**: `data` routes and `actions` | None |
| To combine several calls, keep state, page through results, use a WebSocket, sign in to a service and call it, or run long operations | **Connector**: `connector.js` | Your connector, sandboxed |
| Nothing from a network, such as a clock or a calculator | **View only**: omit `sources`, `data` and `connector` | None |

Start declarative when you can. Users trust it more, and there's less to break. Move to a connector when the declarative routes can't express what you need.

## Walkthrough: a download queue with posters

This builds a declarative widget for a Radarr server: the download queue with each movie's poster. Radarr wants its API key in an `X-Api-Key` header.

**1. The manifest.** Create a folder with this `widget.json`, plus an `icon.svg` (any square SVG or PNG up to 256 KiB):

```json
{
  "apiVersion": 2,
  "id": "plugin.radarr-queue",
  "title": "Radarr queue",
  "description": "Movies downloading now, with posters.",
  "version": "1.0.0",
  "category": "Music & media",
  "icon": "icon.svg",
  "view": {"entry": "index.html", "viewport": "native", "theme": true},
  "sources": {
    "min": 1, "max": 1,
    "auth": {"header": "X-Api-Key"},
    "test": ["api/v3/system/status"],
    "addressLabel": "Radarr URL",
    "addressPlaceholder": "http://radarr.local:7878/",
    "credentialLabel": "API key"
  },
  "displayName": {"serverField": "status.value.instanceName"},
  "data": [
    {"id": "status", "path": "api/v3/system/status", "every": 300},
    {"id": "queue", "path": "api/v3/queue?includeMovie=true&pageSize=20", "every": 5}
  ],
  "permissions": ["images", "ui"],
  "images": ["api/v3/mediacover/*/*.jpg"]
}
```

What each part does:

- **`sources`** asks the user for one connection. The connection form uses your labels. **Test** reads `api/v3/system/status` with the key, so the user knows the address and key work before they leave the form.
- **`auth: {"header": "X-Api-Key"}`** tells Dashledge how to send the key. See [Connecting to real servers](#connecting-to-real-servers) for the other forms.
- **`data`** polls two routes, relative to the address the user typed, every 300 and 5 seconds.
- **`displayName.serverField`** points at the server's own name inside your data. Dashledge shows the name the user gave the connection, else this field, else the host.
- **`images`** lets the view load posters from routes that match the pattern. `*` matches within one path segment.
- **`ui`** links Dashledge's stylesheet, with its `dl-*` classes and tokens.

**2. The view.** `index.html`:

```html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><link rel="stylesheet" href="style.css"><script defer src="view.js"></script></head>
<body class="dl-surface">
  <header><h1 id="server">Radarr</h1><p class="dl-caption" id="summary">Loading…</p></header>
  <ul class="dl-list" id="queue"></ul>
</body>
</html>
```

`view.js`:

```js
const list = document.getElementById('queue');
const summary = document.getElementById('summary');

Dashledge.onData(({data}) => {
  // Each declarative route arrives as data.<id>: {value, at} or {error, at}.
  const status = data.status?.value;
  document.getElementById('server').textContent = Dashledge.displayName(status?.instanceName);

  const queue = data.queue;
  if (!queue) return;                                    // the first poll hasn't come back yet
  if (queue.error) { summary.textContent = 'Radarr unavailable · ' + queue.error; return; }
  const records = queue.value.records || [];
  summary.textContent = records.length ? records.length + ' downloading' : 'Nothing downloading';

  list.replaceChildren(...records.map(item => {
    const row = document.createElement('li');
    row.className = 'dl-row';
    const poster = document.createElement('img');
    poster.alt = '';
    poster.width = 60; poster.height = 90;              // reserve the space even if artwork is missing
    Dashledge.image(`api/v3/mediacover/${item.movieId}/poster-250.jpg`).then(url => poster.src = url, () => {});
    const title = document.createElement('span');
    title.textContent = item.movie?.title || item.title;  // always textContent, never innerHTML, for server data
    const left = document.createElement('span');
    left.className = 'dl-caption';
    left.textContent = item.timeleft || item.status;
    row.append(poster, title, left);
    return row;
  }));
});
```

**3. Try it.** Load the folder with **Load unpacked package**. Open the widget in Widget Studio, choose **Add connection**, enter your Radarr URL and API key, and select **Test**. Add the widget to a page and pick that connection.

That's a complete plugin. No package code runs outside the view, and the API key never reaches your files.

## When you need a connector

A connector is `connector.js`, run in its own JavaScript context with no files, processes or modules. It reaches only the connection's address and the extra `hosts` you declare, and Dashledge adds the credential to requests for the connection. It sends data to the view with `dashledge.emit(data)`.

**A connector replaces `data` polls.** When the manifest has a `connector`, Dashledge doesn't poll `data` routes, so the connector fetches everything itself. The view then receives exactly what you emit: `data.queue` below, not `data.queue.value`. `actions`, `images` and `streams` keep working beside a connector.

To turn the walkthrough's widget into a connector widget, remove `data` from the manifest and add:

```json
"connector": {"entry": "connector.js", "hosts": ["https://api.themoviedb.org"], "storage": 65536, "commands": ["search"]}
```

```js
// connector.js: Radarr queue plus today's calendar, one emit for the view.
const base = dashledge.connection.address;      // the resolved address, ending in "/"

async function refresh() {
  try {
    const [queue, calendar] = await Promise.all([
      fetch(base + 'api/v3/queue?includeMovie=true').then(r => r.json()),
      fetch(base + 'api/v3/calendar?start=' + new Date().toISOString().slice(0, 10)).then(r => r.json()),
    ]);
    dashledge.emit({queue: queue.records, calendar});
  } catch (error) {
    dashledge.emit({error: String(error.message || error)});
  }
}
refresh();
setInterval(refresh, 10_000);

// The view calls Dashledge.command('search', {movieId: 12}).
dashledge.onCommand('search', async ({movieId}) => {
  const r = await fetch(base + 'api/v3/command', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({name: 'MoviesSearch', movieIds: [movieId]}),
  });
  return {ok: r.ok};
});
```

Things to know:

- **`dashledge.connection.address` is the resolved base and ends in `/`.** Append relative paths such as `'api/v3/queue'`, not `'/api/v3/queue'`.
- **Synchronous work has a 2-second watchdog.** A connector that blocks longer is stopped, and the view gets the error. Awaiting a request doesn't count.
- **Requests time out after 15 seconds.** Pass `{timeout: 600}` (seconds, at most 600) for slow operations such as loading a model.
- **Redirects aren't followed. Responses are capped at 8 MiB, request bodies and `emit()` data at 1 MiB.**
- **`r.arrayBuffer()` reads binary bodies**, and `WebSocket` sends and receives `ArrayBuffer`s.
- **`dashledge.storage` keeps up to your declared `storage` bytes** (1 MiB at most) across restarts. Use it to show the last good reading after a restart.
- **A connector serves every placement on the same connection**, so per-placement settings reach only the view. Filter in the view.

The full list is in [The connector API](example/README.md#the-connector-api), [Commands to your connector](example/README.md#commands-to-your-connector) and [Several connections](example/README.md#several-connections).

## Connecting to real servers

Set `sources.auth` to how the server expects its credential:

| Server expects | `auth` | Examples |
| --- | --- | --- |
| `Authorization: Bearer <token>` | `"bearer"` | Home Assistant, Unraid |
| A custom header | `{"header": "X-Api-Key"}` | Radarr, Sonarr, Prowlarr, Lidarr |
| A header with a format | `{"header": "Authorization", "format": "MediaBrowser Token=\"{key}\""}` | Jellyfin |
| A key in the URL | `{"query": "apikey"}` | SABnzbd |
| Basic auth | `"basic"`, with `"usernameLabel": "Username"` | NZBGet |
| A sign-in form, then a cookie | `{"login": {"path": "api/v2/auth/login", "fields": {"username": "{user}", "password": "{key}"}, "session": "cookie"}}` | qBittorrent, Frigate on port 8971 |
| A sign-in form, then a token | `{"login": {…, "body": "json", "session": {"token": "/access", "format": "Bearer {token}"}}}` | Dispatcharr |
| Nothing | `"none"` | A server on your LAN without auth, public APIs |

For sign-in forms, Dashledge signs in when it first needs to and keeps the session in memory. If the server answers 401 or 403 later, it signs in once more. Test always signs in fresh. Add `"usernameLabel"` whenever you use `{user}` or `basic`, so the connection form asks for it.

**One widget for several products.** A download-client widget can serve SABnzbd, NZBGet and qBittorrent. Declare `sources.types`, each with its own `auth`, `test` and labels. The connection form asks which product it is, and your code branches on `dashledge.connection.type` (connector) or `Dashledge.connectionType()` (view):

```json
"sources": {"min": 1, "max": 1, "auth": "none", "types": [
  {"id": "sabnzbd", "label": "SABnzbd", "auth": {"query": "apikey"}, "test": ["api?mode=version&output=json"], "credentialLabel": "API key"},
  {"id": "nzbget", "label": "NZBGet", "auth": "basic", "test": ["jsonrpc/version"], "usernameLabel": "Username", "credentialLabel": "Password"},
  {"id": "qbittorrent", "label": "qBittorrent", "usernameLabel": "Username", "credentialLabel": "Password", "test": ["api/v2/app/version"],
   "auth": {"login": {"path": "api/v2/auth/login", "fields": {"username": "{user}", "password": "{key}"}, "session": "cookie"}}}
]}
```

**Several servers in one placement.** With `"max": 4`, a placement holds up to four connections, such as Radarr and Sonarr behind one reverse proxy. A connector sees them all in `dashledge.connections`, and each request carries the credential of the connection whose address it falls under. See [Several connections](example/README.md#several-connections).
## Artwork and live video

**Images.** Add `"images"` to `permissions` and list route patterns in `images`. `Dashledge.image(path)` resolves with a `blob:` URL for an `<img>`. Dashledge fetches the image with the connection's credential and accepts only JPEG, PNG, GIF or WebP. It caches images for 10 minutes; pass `{fresh: true}` for camera snapshots. Full URLs on a declared connector host work too, such as `https://image.tmdb.org/t/p/*/*`.

**Live video and other streams.** Add `"stream"` to `permissions` and declare WebSocket routes in `streams`. `Dashledge.stream.open(id, params)` opens one on the connection. Text frames arrive as strings and binary frames as `ArrayBuffer`s, and a widget keeps at most four streams open. For Frigate and other go2rtc cameras, copy [`example/samples/mse-player.js`](example/samples/mse-player.js) into your view and call `playLive(video, 'live', {camera: 'front_door'})`. It plays fragmented MP4 through Media Source Extensions.

> **Important:** in the sandboxed view, attach a `MediaSource` with `video.srcObject = mediaSource`. A `blob:` media URL doesn't play there. The sample does this for you.

See [Capabilities](example/README.md#capabilities) and [Live camera video (Frigate)](example/README.md#live-camera-video-frigate).

## Designing for the Edge

The XENEON EDGE is a 2560 × 720 touch display at arm's length. Widgets that feel native follow these rules:

- **Decide what's noticed first,** such as the current reading, the playing track or the camera, and give it the strongest emphasis. Put settings and history behind a secondary view.
- **Render at the real size.** Use `"viewport": "native"` and size with `clamp()`, viewport units or `calc(Npx * var(--px-scale, 1))`. The same widget must also read well in a narrow tile on a split page. Stack panes or drop secondary details before you shrink the primary text.
- **Make targets fingertip-sized:** at least 44 × 44 CSS pixels, with the glyph centered. Label icon buttons for accessibility, and show pressed and focus states.
- **Keep live numbers steady.** Use tabular digits and reserve space for the unit and precision, so a changing value doesn't shift its neighbors. Tell apart *zero*, *idle* and *unavailable*.
- **Make every state actionable.** Show loading, empty and failure differently. Say what's wrong ("Radarr unavailable · HTTP 401") and keep the last good data on screen with its age.
- **Preserve the source's identity.** Use posters, avatars and service colors, and reserve the artwork's space when it's missing.
- **Follow the user's colors:** set `"view": {"theme": true}` and use `var(--text)` and `var(--accent)`, or `state.theme`. Each placement can then have its own colors.
- **Touch just works.** Use ordinary buttons, links and scrolling containers. Dashledge replays touches from the Edge as pointer events, and a sideways swipe turns the page unless something under the finger scrolls sideways. Mark range sliders with `data-edge-range`.
- **For text entry, ask for the `keyboard` permission** and call `Dashledge.keyboard.open()`. It opens the shared touch keyboard, which also accepts typing.
- **Per-placement options** go in `settings` with the `settings` permission. Users edit them in Pages & layouts or from your own gear button with `Dashledge.settings.open()`.

Before you share a widget, try it full screen and in a small tile. Test a long real title, an empty result, a wrong API key, a stopped server, and a refresh while you're scrolled down a list.

## Package, install, update and share

**Package.** Zip the folder's contents so that `widget.json` is at the top level, or inside a single folder:

```sh
cd my-widget && zip -r ../my-widget.zip . -x '.*' '*/.*'
```

Packages are limited to 8 MiB, 4 MiB per file and 256 files. Allowed files are HTML, JS, CSS, JSON, images, fonts, text, licence and TypeScript sources. Links and hidden files are refused.

**Install.** Choose **Widget Studio → Install package** and pick the ZIP. The install sheet lists where the data comes from, the hosts, and every capability.

**Update.** Keep the same `id` and raise `version`. Installing over the old version keeps every placement, and the sheet marks capabilities that are new.

**Share.** A ZIP is the whole distribution. Attach it to a GitHub release of your repository, together with its source. Tell users which server versions you tested, and how to find the API key or account the widget needs.

## Troubleshooting

| You see | Why | Fix |
| --- | --- | --- |
| Install refuses with "unknown field" | A typo or a field that doesn't exist | Check the name against [widget.json](example/README.md#widgetjson) |
| "Installed packages can't run a collector" | `collector` is for widgets built into Dashledge | Use declarative routes or a connector |
| Test fails with HTTP 401 or 403 | Wrong key, or the wrong `auth` form | Check how the server expects the key. For sign-in forms, check `fields` |
| "… isn't a host this widget declared." | The connector reached a host outside the connection | Add the origin to `connector.hosts`, or fix the URL |
| A path is doubled (`//api`) or missing | You joined a path to `connection.address` with a leading `/` | The address ends in `/`, so append `'api/…'` |
| The connector log shows a stop after 2 seconds | Synchronous work blocked the connector | Break the work up, or move it to the view |
| "Response exceeds 8 MiB" | The route returns too much | Ask the server for a page, for example with `pageSize` |
| `Dashledge.image` rejects | The path doesn't match an `images` pattern, or the reply isn't JPEG, PNG, GIF or WebP | Check the pattern (`*` is one segment) and strip a leading `/` |
| Video stays black | The view used a `blob:` URL | Use `video.srcObject = mediaSource`, or `samples/mse-player.js` |
| "Unknown widget command" in the view | The capability or command isn't declared | Add it to `permissions` or `connector.commands`, then **Reload** |
| Changes to `widget.json` don't show | Manifest changes need a reload | Choose **Reload** on the widget's page |

Found a bug in Dashledge itself, or need something the platform doesn't offer yet, such as a new auth form? Open an issue on [GitHub](https://github.com/dgruhin-hrizn/dashledge/issues) with the manifest you tried.
