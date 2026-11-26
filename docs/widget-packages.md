# Widget packages: architecture and rules

Read this before you build a new widget or change how widgets load, talk to Dashledge, or store settings. The package author guide, [`widgets/example/README.md`](../widgets/example/README.md), documents the public manifest and APIs for third-party authors. This document records the design behind them, and the rules that keep it safe and consistent.

## The model in one paragraph

Every widget with its own view is a **package**: a folder with a `widget.json` manifest, a `view/`, and optionally a collector or connector that gets its data. The app has no per-widget code paths. It reads everything it needs, such as title, icon, connections, auth, Test routes, outputs, commands, display-name field, viewport and theme, from the manifest, which `src-tauri/src/package_manifest.rs` validates. Every view runs in a sandboxed iframe with an opaque origin and reaches Dashledge only by `postMessage` through the package bridge. Data reaches a view in one of three trust tiers, and each placement of a widget on a page keeps its own connection, settings and colours.

## Where things live

| Path | Role |
| --- | --- |
| `widgets/packages/<kind>/` | Bundled packages: `widget.json`, `view/`, `collector/`, optional `DESIGN.md` |
| `widgets/packages/_shared/` | Code shared by bundled collectors (`context.mjs`, `gpu-sampler.mjs`) |
| `<app_data>/packages/<id>/` | Installed third-party packages (view and connector only) |
| `<app_data>/packages-unpacked.json` | Folders loaded with **Load unpacked package**, served in place |
| `widgets/example/` | The downloadable example package, author guide, `dashledge.d.ts` |
| `src-tauri/src/package_manifest.rs` | The manifest schema and **the only validator** |
| `src-tauri/src/package_store.rs` | Install, extract, list, look up; unpacked folders and their watcher |
| `src-tauri/src/widget_host.rs` | Bundled collectors (Node), view file serving, view CSP |
| `src-tauri/src/package_connector.rs` + `connector.m` + `connector_prelude.js` | Installed packages: declarative polls and actions, sandboxed JavaScriptCore connectors, connector logs |
| `src-tauri/src/connections.rs` | Connection addresses (`endpoint`, `resolve`), Test, credentials and CA in requests |
| `src-tauri/src/vault.rs` | Encrypted credentials and CA certificates, keyed by `kind\|address` |
| `ui/packages.js` | Registers bundled packages from `list_packages` into the UI tables |
| `ui/widget-catalog.js` | Catalog entries; `packageEntry()` turns a manifest into a layout plugin entry |
| `ui/original-widgets.js` | `mountOriginal` (bundled) and `mountPackage` (installed): create the sandboxed frame and drive its feed |
| `ui/package-bridge.js` | Host side of the bridge: state, commands, capability gates |
| `ui/package-sdk.js` | Injected into every view as `window.Dashledge` |
| `ui/package-settings.js`, `ui/placement-colors.js` | Per-placement settings and colours: resolution and the shared editors |
| `ui/package-choices.js` | Options views offer for `dynamic` settings, kept per widget and connection; Check now |
| `ui/package-manifest.js` | Install-sheet text (`permissionSummary`) and tier names |
| `ui/package-ui.css` | The `ui` capability's stylesheet |

## Trust tiers

| Tier | Who may use it | Runs where | Network |
| --- | --- | --- | --- |
| **Declarative** (`data`, `actions`) | Anyone | No package code; Rust makes the requests | Only the placement's connection, with its saved credential |
| **Connector** (`connector`) | Anyone | Package JavaScript in an isolated JavaScriptCore context with no files, processes or modules; a 2-second watchdog | Only the connection origin and the manifest's `hosts`; Rust adds the credential; no redirects; size caps |
| **Collector** (`collector`) | Bundled packages only | Node with full access to the Mac | Anything |

The validator refuses a collector in an installed or unpacked package. A view on its own (no data) is allowed too.

## How data reaches a view

**Bundled widget (collector):**
1. `mountOriginal` calls `widget_open` with the placement's connections.
2. `widget_host::launch` resolves each address (`connections::resolve`), reads credentials from the vault, and starts the collector. Its first stdin line carries the setup. Credentials never enter argv, the view or the snapshot directory.
3. The collector reads the setup through `_shared/context.mjs` and writes its declared `outputs` (for example `snapshot.js`) into a private temporary directory.
4. The view loads them from its own origin with `<script>` and `<img>`. `snapshot.js` calls a global such as `window.proxmoxSample(...)`. Only the declared outputs and the view folder are served.
5. Viewers ping the feed. A feed with no viewers is reaped.

**Installed package (declarative or connector):**
1. `mountPackage` calls `package_open`, which returns the feed ID, the view entry and the **permissions from the manifest on disk**.
2. Rust polls the declarative routes, or runs the connector, which calls `dashledge.emit()`.
3. `mountPackage` polls `package_read` every second and passes the data to the view through the bridge (`Dashledge.onData`). A `{reload: true}` reply means an unpacked folder changed, so the view and connector reopen.

## The bridge

- A message counts only when its `source` is a registered frame's `contentWindow`. Everything else is ignored.
- `packageState(entry)` is what a view sees in `Dashledge.subscribe`:
  - the theme: the placement's colours, else General;
  - the display name, server name and host;
  - the viewport (`native` or `reference`);
  - the permissions;
  - the settings, when the `settings` permission is declared.
- **Commands** run only when the manifest declares them:
  - `model`, and any other command in `collector.commands` (sent to the collector's stdin as `{command, args}` by `widget_command`);
  - `action` for declarative actions, which Rust checks again;
  - `settings.open`, `settings.offer`, `keyboard.open`, `mac.metrics` and `mac.subscribe` when the matching permission is present.
  - Anything else gets `Unknown widget command`. The bridge is the enforcement point; SDK-side checks are convenience only.
- Touch from the Edge is forwarded into frames. The SDK replays it as pointer events, scrolling and taps, then reports whether a horizontal drag belongs to the page, so page swipes still work.
- The view CSP names `tauri://localhost` explicitly. `'self'` blocks every script in an opaque-origin frame.

## Per-placement state

A **placement** is one slot on one page. Keep its choices with it, never in the widget or in General.

| What | Stored on the slot | Edited from | Reaches the widget |
| --- | --- | --- | --- |
| Connection | `source` | Pages & layouts | Collector or connector setup |
| Package settings | `packageSettings` | The placement panel in Pages & layouts, or the view's gear (`Dashledge.settings.open()`) | `subscribe` state, live |
| Colours | `colors: {primary?, accent?}` | The placement panel in Pages & layouts (Highlight and Text) | Tile CSS variables, or the view's theme, live |

Settings and colours are left out of the dashboard's page signature, so changing them updates the live view without rebuilding the page. The placement panel (`placementPanel` in `ui/editor.js`) keeps colours and settings in one draft. While it differs from the saved slot, the panel writes it to `localStorage['edge.placementPreview']` (`writePreview` in `ui/placement-colors.js`), and the dashboard shows it on that one placement (`shown()` in `ui/dashboard.js`) until Save or Discard. Selecting another placement or leaving the tab discards the draft. The panel and the gear draw settings with the same `settingsForm` (`ui/package-settings.js`). Saving refuses when the section no longer holds the widget ("This section changed"). Settings reach only the view: a connector serves every placement on the same connection.

**Dynamic settings** (`settings.choices`). A `choice` or `multi` setting marked `dynamic` lists what the view finds at run time, such as the accounts on this Mac, instead of options in the manifest. The view calls `Dashledge.settings.offer(id, options)`; the bridge cleans the list and stores it in `localStorage['edge.packageChoices']`, keyed by widget and connection, so the placement panel and the gear list it in any window even when no view is on screen. Values are checked by shape only, never against the latest offer: a saved account that is offline right now keeps its place and its name, and the editor shows it as not available. **Check now** writes a request that every window's bridge forwards to live views of that widget and connection (`Dashledge.settings.onRefresh`). A `names` setting holds the user's name for each option of the setting named by `for`. Bundled packages have no Widget Studio defaults: a new placement starts from the manifest's defaults.

## Manifest fields that change app behaviour

`package_manifest.rs` is the reference; unknown fields are refused. These are the fields the host acts on:
- `view.viewport`: `native` renders at the display's real size when the widget fills a page. The SDK sets `--px-scale` (4/3 on the Edge) so px-authored sizes keep their physical size.
- `view.theme: true`: the view follows Dashledge's colours (`state.theme`, also set as `--text` and `--accent`). Only then does Pages & layouts offer per-placement colours.
- `sources`:
  - `min`/`max`: how many connections a placement takes.
  - `auth`: which header carries the credential.
  - `address`: `path` keeps the address's path as the base; `origin` drops it.
  - `test`: the routes the **Test** button reads.
  - The labels shown in the connection form.
- `displayName.serverField`: the dot path where the server reports its own name. The display name is the user's connection name, else that field, else the address's host.
- `permissions` and `settings`: capabilities and the per-placement settings schema. Rust fills defaults. `dynamic` settings need `settings.choices`; `multi` values are lists (`["*"]` is every option), `names` values map option values to names.
- `collector.outputs` / `collector.commands`: the only files served from the collector's directory, and the only commands the bridge forwards. A collector reads its commands with `onCommand(name, fn)` from `_shared/context.mjs`.

## Rules

1. **No per-kind code in the host.** Don't add `if kind == …` to `widget_host.rs`, `connections.rs`, `model.js`, `widget-catalog.js`, `dashboard.js` or `editor.js`. If the host needs to know something, add a manifest field, validate it in Rust, and read it.
2. **One validator.** Every manifest rule lives in `package_manifest.rs`, with a Rust test. The UI reads the normalized manifest that the commands return.
3. **Views stay sandboxed.** Never add `allow-same-origin` and never reach into a frame's document from the dashboard. If a view needs something, add a bridge message or command.
4. **A capability is a permission.** Adding one means:
   - a `Permission` variant in Rust;
   - a line in `permissionSummary` (marked "New:" on update);
   - a gated command in `handleMessage`;
   - an SDK entry;
   - declarations in `widgets/example/dashledge.d.ts`;
   - an author-guide section.

   `tests/package-dev-tools.test.mjs` fails if the declarations drift from the SDK. Expose a documented subset of host data, copying fields explicitly (see `publicMetrics`), never raw internals.
5. **Package-supplied text goes in as text.** Labels, options, titles and placeholders are set with `textContent` (`el()` in `common.js`), and Rust caps their length and refuses control characters. A keyboard sheet always shows the package's own title.
6. **Credentials stay in Rust.** Collectors get them on stdin, connectors never see them, and views never do. Vault keys are `kind|endpoint(address)`. Request URLs come from `connections::resolve`, which applies the manifest's address mode. Test and the widget must always use the same base.
7. **Bundled collectors share code through `_shared/`.** Don't import across packages (`../../proxmox/...`).
8. **Bump the package `version` in `widget.json` when you change a package,** and update any test that pins it.
9. **Design rules can be widget-specific.** A package's `DESIGN.md` (for example `widgets/packages/omlx/DESIGN.md`) applies to that widget only. Promote a rule to AGENTS.md's shared principles only when the user agrees.
10. **Gate on the real exit status.** Run `npm test` and check its exit code before committing; don't chain a commit after a `grep` of the output.

## Recipes

**A new bundled widget:**
1. Create `widgets/packages/<kind>/` with `widget.json`, `view/index.html`, an icon, and `collector/<entry>.mjs` reading `context` from `../../_shared/context.mjs`.
2. Declare `outputs`, plus `commands` if the view sends any.
3. Add `view.viewport: "native"` and size type with `calc(Npx*var(--px-scale,1))`.
4. Add `view.theme: true` if the view uses `state.theme`.
5. Set `displayName.serverField` if the server reports a name.
6. Add tests under `tests/` for the collector's parsing and anything the view computes.

Nothing else in the app changes: `list_packages` registers it in the catalog, the editor and the dashboard.

**A third-party package:** start from `widgets/example/`. Prefer declarative data. Use a connector only for joins, WebSockets or state, and declare every extra host. Load the folder with **Load unpacked package** while developing; files reload on save, and **Connector log** shows `console` output.

**A new per-placement option for all widgets** (like colours): store it on the slot, leave it out of the page signature, apply it in `renderTile`, and pass it to `mountOriginal`/`mountPackage` and `registerFrame` with a live update method. Add its control to the draft part of the placement panel, carry it in the preview so the Edge shows it before Save, and offer it only where the widget honours it.

## Verifying a change

- `npm test` runs the JavaScript and Rust tests, including every bundled package validating and its files existing.
- For views: check the Edge viewport (2560 × 720, native) and a compact placement. Use long real labels, empty and failed states, and a live refresh. See AGENTS.md's widget design principles and full-screen rendering rules.
- For settings: configure two placements differently, edit one, cancel an edit on the other, and reopen the app.
- Build a personal app with `scripts/package-mac.sh --prepare-only` and install it with `scripts/sign-mac.sh` (see AGENTS.md).
