# Commands

Install dependencies with `npm ci`. Run the app in development with `npm run dev`. Run `npm test` for the JavaScript and Rust tests before opening a pull request.

# Widget development

For each new widget or update to an existing widget, create a dedicated branch and Git worktree from the latest `origin/main`. Implement and test that widget in its worktree, then push the branch and open one pull request targeting `main`.

Merge every widget PR intended for a release before signing. Sync a clean `main` checkout to the merged revision, run `npm test`, and prepare a fresh app from that checkout. For a public release, follow the release procedure below.

## Widget packages

Every widget with its own view is a package. The host reads all of its per-widget details from the package’s `widget.json`, which `src-tauri/src/package_manifest.rs` validates as the only validator.

Read [`docs/widget-packages.md`](docs/widget-packages.md) before building a widget or changing how packages load, talk to Dashledge or store placement state. It maps the code, the data flow, the trust tiers, the bridge and per-placement state, and lists the rules and recipes. For widget authors outside the project, [`widgets/README.md`](widgets/README.md) walks through building a package, and [`widgets/example/README.md`](widgets/example/README.md) is the reference that ships in the downloadable example. Keep both current when the manifest, the SDK or a capability changes.

### Plugins first

Dashledge is moving every widget to a true plugin system. A plugin is a package with a `plugin.` ID that Dashledge runs sandboxed. The user installs it, gives it a host address and a credential, and nothing outside its manifest is trusted.

- **Build each new widget that talks to a server as a plugin.** Make it declarative (`data`/`actions`), or give it a connector if it needs joins, WebSockets, state or long operations. Don't write a new Node collector for it. Collectors are only for widgets that need this Mac itself, such as its files, its CLIs or a native API.
- **Extend the platform instead of working around it.** When a plugin can't do something a collector could, add it to the host as a manifest field or capability, with its validation, tests and docs. Examples are a new auth form, a binary format or a capability. Don't reach for a collector.
- **The platform gives plugins these pieces. Reuse them:**
  - **Auth forms:** `bearer`, a custom header with an optional format, a query key, `basic` with a username, `emby-token`, `pve-token`, and `login` sessions (cookie or token).
  - **`sources.types`:** one widget for several products, such as SABnzbd, NZBGet and qBittorrent, or Emby and Jellyfin, each with its own auth and Test.
  - **Several connections per placement.**
  - **The `images` capability:** posters and snapshots.
  - **The `stream` capability:** a WebSocket relayed to the view. Play live MSE video with `video.srcObject`, never a `blob:` URL.
  - **Connector commands:** `Dashledge.command` from the view to the connector.
  - **Binary connector I/O.**
- **Credentials stay in Rust.** Rust adds every credential and sign-in session, only on the connection's own origin. It scrubs any echo of it in replies, so connectors and views never see it. A package can't set `Authorization`, `Cookie`, `Host`, `X-Emby-Token`, `Proxy-Authorization`, `Content-Length` or its own credential header.
- **Migrating a bundled widget to a plugin** is its own branch and PR, like any widget. The PR says what happens to existing placements and saved connections.

### Package layout and the host

- Bundled widgets live in `widgets/packages/<kind>/` with `widget.json`, `view/`, and a Node `collector/`. Shared collector code lives in `widgets/packages/_shared/`. Installed packages are extracted to `<app_data>/packages/<id>/` and may not declare a collector.
- A package may carry its own design rules in `DESIGN.md` (for example `widgets/packages/omlx/DESIGN.md`). They apply only to that widget; follow them when changing it.
- To add or change a bundled widget, edit its package. Its title, category, icon, connection count, auth header, address label, Test routes, collector outputs and commands, display-name field, and native viewport come from the manifest. Don’t add per-kind cases to `widget_host.rs`, `connections.rs`, `model.js`, `widget-catalog.js`, `dashboard.js` or `editor.js`.
- Package views run in `sandbox="allow-scripts"` frames with an opaque origin. Never give a view same-origin access or reach into its document from the dashboard. Everything a view needs passes through the message bridge: `ui/package-bridge.js` on the host and `ui/package-sdk.js` in the frame. The bridge refuses commands and capabilities that the manifest doesn’t declare. Serve view files with the explicit `tauri://localhost` CSP from `widget_host.rs`; `'self'` blocks scripts in an opaque-origin frame.
- Views name a server with `Dashledge.displayName()`: the connection name the user typed, else what the server reports at `displayName.serverField`, else the address’s host. Never hardcode a server or host name in a view or collector.
- A new capability needs a `Permission` in the manifest, a line in the install sheet (`ui/package-manifest.js`), a gated command in the bridge, an SDK entry, declarations in `widgets/example/dashledge.d.ts`, and a section in `widgets/example/README.md`. `tests/package-dev-tools.test.mjs` checks that the declarations match the SDK.

## Widget design principles

- **Choose what gets noticed first.** On a music deck it is the current track and playback controls. On a CPU tile it is the reading and its unit. On a photo page it is the photographs. Give that content the strongest visual emphasis. Move settings, history, and occasional actions into a clearly reachable secondary view.
- **Compose for the available space.** Follow the full-screen rendering rule below. Use the wide Edge for related content side by side, as Mail & Calendar does. In a narrow tile, stack panes, show one pane at a time, or drop secondary details before reducing reading size. Keep the primary action reachable with long titles and real data.
- **Preserve the source’s identity and meaning.** Use available album covers, posters, avatars, and service colors. Reserve the same space for a fallback when artwork is missing. Render Slack names, mentions, and thread structure as people recognize them. Related widgets should share controls and message rendering so a user can move between them without relearning the interface.
- **Design for a fingertip at desk distance.** Use legible, high-contrast type and hit areas at least 44 × 44 CSS pixels on the Edge, including pagination and icon buttons. Center the glyph inside its hit area. Label icon controls for accessibility, show pressed and keyboard-focus states, preserve bezel navigation, and use the shared touch keyboard for text entry.
- **Keep live views steady.** Use tabular digits and reserve space for the expected precision and unit so a changing reading cannot shift its neighbors. Animate toward the latest sample and distinguish zero, idle, and unavailable data. Preserve selection and scroll position across refreshes. Honor reduced motion and give continuously moving galleries a pause control.
- **Make first use and waiting actionable.** An empty Shortcuts tile offers “Choose shortcuts.” A disconnected service should offer its connection action. Distinguish loading, an empty result, and failure. For large collections, show a usable first page as soon as it arrives, reuse cached results, and load visible artwork independently. Keep each placement’s display choices with that placement.

When reviewing a widget PR, exercise its main task in the full Edge viewport and a compact placement. Try a long real-world label, a missing or empty input, and a live refresh where applicable. Check that the user can still read the primary content, tap the intended control, and return to where they were.

## Widget settings

- **Put each choice where its effect is clear.** Widget Studio manages shared accounts, named connections, and widget defaults. Pages & layouts configures a specific page and section. A gear on the live widget edits that same placement. Identify the scope in the editor, especially when changing a default or disconnecting a shared account.
- **Reuse the same editor across entry points.** Follow Apple Photos and Mac Shortcuts, which open the same configuration interface from the layout editor and the display. Start with the placement’s saved values. Give a new placement useful defaults and offer setup immediately if it needs a source or selection to work.
- **Use controls that show the choice.** Use named source pickers, grouped calendar or album lists, and visual samples for appearance settings. Show ordering for pinned shortcuts. Make selected items easy to identify and find again in large libraries. Support the shared touch keyboard on the Edge and ordinary typing in desktop Settings.
- **Make saving predictable.** Keep multi-step edits in a draft. Save applies the draft to the indicated scope and updates the widget. Cancel discards it. For immediate controls such as swapping panes, reflect the change immediately and remember it for that placement. Keep independent placements and their explicit overrides intact when editing one of them.
- **Explain missing prerequisites at the control.** Identify the account, permission, or source needed and offer the relevant Connect, Allow, Test, or Retry action. Preserve the draft across recoverable failures. Keep credentials in the existing connection store and out of layout data and previews.

For a settings change, configure two placements differently, edit one, cancel a second edit, then reopen the app. Verify both placements retained their intended values. Exercise each supported settings entry point and the disconnected or permission-denied state when applicable.

# Cutting a public Dashledge release

1. **Prepare and merge.** Choose the stable version and run `node scripts/release-version.mjs <version>` from the repository root to update the Node, Cargo, and Tauri manifests and lockfiles together. Use the normal Git and GitHub PR workflow to push and merge the version bump and every intended widget change. Confirm both the changes and the version on GitHub’s `main`, then fast-forward the clean local `main` checkout in `~/edge-workbench`.
2. **Publish.** Run the existing command directly in Mac Terminal on Apple Silicon:

   ```sh
   ~/edge-workbench/scripts/release-mac.sh
   ```

   Use this command for every public release. Never create a per-widget or per-version wrapper, including one that combines PR preparation with publishing. The script reads the version from the local checkout, clones GitHub’s `main`, runs the tests, builds the public app without personal Run-DMD artwork, signs with the HORIZN INC Developer ID, notarizes and staples the app, and uploads the ZIP and checksum.
3. **Verify publication.** Confirm that GitHub’s `releases/latest` endpoint returns `v<version>` and lists both `Dashledge-v<version>-macOS-arm64.zip` and its `.sha256` file. Then report the published release URL. Dashledge checks this same endpoint for updates.

If a push or merge is blocked, identify the pending branch or PR and the GitHub error so work can resume at that step. If the changes are merged and the current shell lacks signing or notarization access, give the user the exact Mac Terminal command above.

# Personal Dashledge macOS builds

Test the changes and prepare the integrated app with `scripts/package-mac.sh --prepare-only`. Use the build's actual output directory and preserve the user's bundled Run-DMD card when preparing their personal build.

For signing and installation, use the repository's `scripts/sign-mac.sh` with the absolute path of the prepared app. For the default output directory, run this command in Mac Terminal.

```sh
~/edge-workbench/scripts/sign-mac.sh "$HOME/edge-workbench/dist/Dashledge.app"
```

Use the actual output directory of the merged build. The script uses the HORIZN INC Developer ID, signs and verifies the bundled Node runtime and app, writes the ZIP, installs into /Applications, and relaunches Dashledge.

If the build shell cannot access the Developer ID, leave the prepared app ready and provide the single pasteable command for the user's Mac Terminal. An ad-hoc signature does not complete this workflow. Confirm the installer reported `Installed and opened /Applications/Dashledge.app` before reporting success.

## Full-screen widget rendering

Render new full-screen widgets directly at the Edge or preview window’s actual viewport size. Scaling a 1920 × 540 dashboard to 2560 × 720 magnifies already-rendered text by 4/3 and can soften glyphs. Use responsive layout and typography to achieve the desired physical size.

- In `ui/dashboard.js`, route the standalone widget through `data-native-viewport`. The shared `fitDashboard` in `ui/general.js` sets the frame to the destination width and height, positions it at the origin, and clears the scaling transform. Embedded widget frames should fill that viewport. Let the browser handle display pixel density.
- Full-screen pages are edge-to-edge, with zero outer border and corner radius. When switching to a split page, restore its existing reference-canvas layout.
- When changing widget sizing, verify through both `edge.html` and `preview.html`. At 2560 × 720, check that the dashboard and any full-screen inner frame measure 2560 × 720 CSS pixels for a host of that size, have no scaling transform, and receive taps at the displayed control coordinates. Also check a resized preview and the transition back to a split page.

## Touch keyboard

Use Spotify’s full-screen search keyboard for text entry on the Dashledge touch display. Open it with `openTouchKeyboard` from `ui/search-keyboard.js`. Spotify, Apple Music, and Slack share this entry point and the keyboard sheet styles in `ui/spotify.css`.

Keep the input and task content on the left and the four-row keyboard on the right on the Edge. Preserve Shift, symbols, Backspace, Space, caret and selection editing, physical keyboard input, and touch targets of at least 44 CSS pixels on the Edge. Give the primary key the action’s name, such as Search or Follow. When changing the keyboard, exercise a touch submission and a physical Enter submission through a consuming widget.
