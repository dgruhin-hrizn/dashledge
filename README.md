# Edge Workbench

Edge Workbench is a macOS menu-bar application for the Corsair XENEON Edge. The Rust/Tauri app runs the touch dashboard and layout editor in system WebKit. It includes the runtime for its six original widget collectors. No separate Node installation or per-widget LaunchAgents are required.

## Install on macOS

Edge Workbench lives at `/Applications/Edge Workbench.app`. For a downloaded release, unzip `Edge-Workbench-macOS-arm64.zip`, quit any running copy of Edge Workbench from its menu bar, and move the app into **Applications**. Choose **Replace** when updating. Launch Edge Workbench from Applications. Your pages, appearance settings and saved connections carry over.

## Use the display and preview

Open **Edge Workbench.app**. The first launch opens Settings on your main display. Choose **Show Window Preview** in General for a floating, resizable Edge dashboard or **Live preview** to see it in Settings. General imports the existing Zurface appearance and layout orientation on first launch. Primary and secondary colors update compatible widgets in every view. Under **Pages & layouts**, choose **+ Add page**, then click **+ Add widget** in the empty section. You can also add a page from the page picker on the Edge. Choose a preset or drag a widget from the library to arrange the page. Split individual sections side by side or stack them vertically. The menu-bar icon reopens Settings.

To use the touchscreen, quit any other app controlling Edge touch. In **General → Display**, select the target and choose **Move to display**. For portrait, choose **Vertical** and set the matching rotation in macOS Displays. Direct touch can be enabled or released in General. Grant Input Monitoring if macOS requests it. Choose **Return to preview** to release the device. The physical dashboard can switch pages using its page picker. Open at Login is available in the menu bar.

## Widgets and connections

The app imports connection settings from the installed Emby and Unraid collectors, Proxmox, ComfyUI workers and oMLX on first launch. The import reads the collectors’ saved settings locally and imports API credentials into the encrypted connection vault. The Proxmox certificate is scoped to its server. Guest SSH targets and identity file paths are retained as references. The Proxmox widget polls its configured running GPU guests over SSH. Ember reads its existing local database. **Connections → Import from Zurface** reruns discovery and fills missing entries. A connection's **Test** button checks its current reachability.

CPU, GPU, memory, disk capacity, network throughput, network interfaces, power and thermal state, and Mac information read local system metrics. The GPU tile reports unavailable on hardware that does not expose the counter. Spotify connects to the running desktop player and may request Automation access. Local and world clocks, focus timer and scratchpad work locally.

Use **Connections → Add connection → Test** for your own servers, then select the connection in the layout inspector. Add separate connections for multiple workers. One macOS Keychain item, **Edge Workbench Connections**, protects the vault. Workbench unlocks it once per running app and shares access across widgets and connection tests. A declined unlock pauses further prompts until you choose **Connections → Unlock connections**. Existing service credentials migrate from accessible entries or the matching installed collector. For a manually configured legacy token, **Connections → ••• → Recover previous credential** requests access to that item once. The layout and widget definitions live in local app storage.

Each original widget opens in its own full-width page. On upgrade, Workbench adds any missing full-width pages once. An existing single-widget page, such as **Media** for Emby, keeps its name. Pages fill the canvas. Swipe left for the next page or right for the previous one. Horizontal carousels keep their own scroll gestures. Start at either bezel to switch pages over a carousel. Tap the background at the middle of the left edge or press **Option-P** to open the page picker. The same widgets can occupy sections of a mixed layout. The Edge and both previews lay widgets out on Zurface’s 1920 × 540 reference canvas (540 × 1920 in portrait), then scale the entire page to fit the display. Opening a dashboard warms the configured collectors for every page. Page switches retain the widget views, and simultaneous previews and output share collectors and Mac telemetry history.

| Widget | Original views and controls |
| --- | --- |
| Emby | Playback wall, session details, stream bitrate, server activity, artwork, weekly viewing and release notes. |
| ComfyUI | Two-worker render wall, WebSocket step progress, queue and history, GPU and system memory, tap-to-reveal output with the original 15-second conceal timer. The selected worker appears first. |
| Unraid | Array and pool devices, disk I/O, CPU, RAM, network history and running containers with icons and charts. |
| Proxmox | Cluster summary, nodes, VM and LXC counts, GPU telemetry on configured running guests, load history and paging. |
| oMLX | Live and historical metrics, animated decode rate, Mac specs, server picker, model inventory, load and unload controls, token usage and weekly graphs. |
| Ember Copper | The original Copper artwork and typography, workspaces and chats, live transcripts, plans and usage reports from the local Ember profile. |
| JSON | Choose a JSON endpoint and field in Widget Studio. |

The views and their static assets live in `widgets/views`. Workbench sends connection settings and credentials directly to the corresponding bundled collector. Each collector publishes display data into a private temporary directory. Opening the same feed in Settings and on the display shares its collector. Visited pages retain their views and histories while the dashboard stays open. Leaving the page conceals ComfyUI output. Quitting the app stops its collectors.

## Create a plugin

Open **Widget Studio → Create widget**, choose the Mac or JSON feed, and choose a field, label, unit, color and presentation (number, sparkline or list). Test the field, save the widget, then place it in Layouts. Export shares its package as a JSON file. Another user can install the package in Widget Studio and select their own connection. Updating an existing package ID preserves layout references.

A minimal package is:

```json
{"apiVersion":1,"id":"plugin.free-memory","title":"Free memory","feed":"mac","field":"freeGiB","unit":"GiB","accent":"#c4f38f"}
```

## Development

For frontend development with the Tauri CLI, run `npm ci` and `npm run dev`. Run `npm test` for the JavaScript and Rust tests.

### Build and install a release

On the signing Mac, with Rust, Xcode Command Line Tools and an official standalone Node 24+ distribution on PATH (or selected with `WIDGET_NODE`), run `./scripts/package-mac.sh`. It signs the app and its bundled Node runtime with the HORIZN INC Developer ID used by Ember, writes the ZIP under `dist/`, then replaces and opens `/Applications/Edge Workbench.app`. The installer verifies the staged copy before quitting a running dashboard and swapping the bundles.

To build and sign in separate sessions, run `./scripts/package-mac.sh --prepare-only`, then `./scripts/sign-mac.sh "dist/Edge Workbench.app"` in the signing session. To install an already signed bundle, run `swift scripts/install-mac.swift "dist/Edge Workbench.app"`. `SIGN_IDENTITY` selects a specific signing identity. `SIGN_IDENTITY=-` produces a local ad-hoc build in `dist/` and skips installation.

This release is an early preview. The detailed [product plan](docs/PLAN.md) tracks the intended catalog, service parity and package runtime. The initial package format supports declarative widgets. The six service dashboards use their original presentation assets and the bundled collectors.

Based on [Edge Starter](https://github.com/joshsorenson/edge-starter), distributed under the MIT license.
