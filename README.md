# Edge Workbench

Edge Workbench is a macOS menu-bar application for the Corsair XENEON Edge. One Rust/Tauri host runs the touch dashboard, layout editor and collectors. The interface uses the system WebKit renderer. The installed app runs without Node, npm, Homebrew, a terminal or per-widget launch agents.

## Try the preview

Open **Edge Workbench.app**. The first launch opens Settings on your main display. Choose **Live preview** for a live Mac dashboard. Under **Pages & layouts**, choose **+ Add page**, then click **+ Add widget** in the empty section. You can also add a page directly from **Pages** on the Edge. Choose a preset or drag a widget from the library to arrange the page. Split individual sections side by side or stack them vertically. The menu-bar icon reopens Settings.

To use the touchscreen, quit any other app controlling Edge touch. Open **Display & touch → Enable Edge output** and save to restart. Grant Input Monitoring if macOS requests it. Choose **Return to preview** to release the device. The physical dashboard can switch pages using its page picker. Open at Login is available in the menu bar.

## Widgets and connections

The app imports connection settings from the installed Emby and Unraid collectors, Proxmox, ComfyUI workers and oMLX on first launch. The import reads the collectors’ saved settings locally and copies API credentials to Keychain. The Proxmox certificate is scoped to its server. Guest SSH targets and identity file paths are retained as references. GPU polling over SSH is pending. Ember reads its existing local database. **Connections → Import from Zurface** reruns discovery and fills missing entries. A connection's **Test** button checks its current reachability.

CPU, GPU, memory, disk capacity, network throughput, network interfaces, power and thermal state, and Mac information read local system metrics. The GPU tile reports unavailable on hardware that does not expose the counter. Spotify connects to the running desktop player and may request Automation access. Local and world clocks, focus timer and scratchpad work locally.

Use **Connections → Add connection → Test** for your own servers, then select the connection in the layout inspector. Add separate connections for multiple workers. Tokens live in the macOS Keychain. The layout and widget definitions live in local app storage.

| Service | Source and current coverage |
| --- | --- |
| Emby | Emby API base. Active playback, posters, viewer/device, play method, progress and carousel details. |
| ComfyUI | Worker URL. Queue and GPU/VRAM statistics. An explicit reveal loads the latest image and the viewer closes after 15 seconds. |
| Unraid | Unraid monitoring-agent REST base ending in /api/v1/. Array, disk inventory and running Docker containers. |
| Proxmox | HTTPS origin and read-only PVE API token. Cluster nodes, guests and status. The server certificate must be trusted by macOS. |
| oMLX | HTTP API origin and optional bearer key. Generation statistics. |
| Ember | Recent chats from the local desktop database, bounded live Claude transcript tails, Markdown, collapsible tool calls, thinking blocks and scroll-to-live. |
| JSON | Choose a JSON endpoint and a field path in Widget Studio. |

## Create a plugin

Open **Widget Studio → Create widget**, choose the Mac or JSON feed, and choose a field, label, unit, color and presentation (number, sparkline or list). Test the field, save the widget, then place it in Layouts. Export shares its package as a JSON file. Another user can install the package in Widget Studio and select their own connection. Updating an existing package ID preserves layout references.

A minimal package is:

```json
{"apiVersion":1,"id":"plugin.free-memory","title":"Free memory","feed":"mac","field":"freeGiB","unit":"GiB","accent":"#c4f38f"}
```

## Development

On macOS with Rust and Xcode Command Line Tools, run `./scripts/package-mac.sh` to build an application and ZIP under `dist/`. Set `SIGN_IDENTITY` to use your Developer ID identity. The default is ad-hoc signing for local builds. For frontend development with the Tauri CLI, use `npm ci` and `npm run dev`. Run `npm test` for model and native tests.

This release is an early preview. The detailed [product plan](docs/PLAN.md) tracks the intended catalog, service parity and package runtime. The initial package format supports declarative widgets. The service tiles implement subsets of the six original dashboards. Validate touch calibration, permissions, service credentials and reconnection on your own hardware before moving a daily setup.

Based on [Edge Starter](https://github.com/joshsorenson/edge-starter), distributed under the MIT license.
