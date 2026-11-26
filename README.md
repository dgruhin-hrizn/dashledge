# Edge Workbench

Edge Workbench is a macOS menu-bar application for the Corsair XENEON Edge. The Rust/Tauri app runs the touch dashboard and layout editor in system WebKit. It includes the runtime for its six original widget collectors. No separate Node installation or per-widget LaunchAgents are required.

## Install on macOS

Edge Workbench lives at `/Applications/Edge Workbench.app`. For a downloaded release, unzip `Edge-Workbench-macOS-arm64.zip`, quit any running copy of Edge Workbench from its menu bar, and move the app into **Applications**. Choose **Replace** when updating. Launch Edge Workbench from Applications. Your pages, appearance settings and saved connections carry over.

## Use the display and preview

Open **Edge Workbench.app**. The first launch opens Settings on your main display. Choose **Show Window Preview** in General for a floating, resizable Edge dashboard or **Live preview** to see it in Settings. Primary and secondary colors update compatible widgets in every view. Under **Pages & layouts**, choose **+ Add page**, then click **+ Add widget** in the empty section. You can also add a page from the page picker on the Edge. Choose a preset or drag a widget from the library to arrange the page. Split individual sections side by side or stack them vertically. The minus on an occupied section clears its widget. The minus on an empty section collapses the split and expands the remaining sections. Undo restores either change. The menu-bar icon reopens Settings.

To use the touchscreen, quit any other app controlling Edge touch. In **General → Display**, select the target and choose **Move to display**. For portrait, choose **Vertical** and set the matching rotation in macOS Displays. Direct touch can be enabled or released in General. Grant Input Monitoring if macOS requests it. Choose **Return to preview** to release the device. The physical dashboard can switch pages using its page picker. Open at Login is available in the menu bar.

## Widgets and connections

Configure each service in its widget’s Settings. Saved connections, credentials, and Proxmox guest SSH mappings carry over on upgrade. The Proxmox certificate is scoped to its server. Ember reads its local database.

CPU, GPU, memory, disk capacity, network throughput, network interfaces, power and thermal state, and Mac information read local system metrics. The GPU tile reports unavailable on hardware that does not expose the counter. The Spotify jukebox reads artwork and playback from the Mac desktop player and may request Automation access. Tap the cover to open Spotify. For Up next, register `http://127.0.0.1:4848/callback` in your Spotify developer app, then choose **Up next → Connect Spotify** and enter its Client ID. Queue access uses browser sign-in and saves the refresh token in the Workbench connection vault. Local and world clocks, focus timer and scratchpad work locally.

Use **Widget Studio → [widget] → Settings → Add connection**, then **Test** for your own servers, then select the connection in the layout inspector. Add separate connections for multiple workers. One macOS Keychain item, **Edge Workbench Connections**, protects the vault. Workbench unlocks it once per running app and shares access across widgets and connection tests. A declined unlock pauses further prompts until you choose **Connection tools → Unlock connections**. Existing service credentials migrate from accessible Workbench Keychain entries. For a manually configured legacy token, the connection’s **••• → Recover previous credential** requests access to that item once. The layout and widget definitions live in local app storage.

Each original widget opens in its own full-width page. On upgrade, Workbench adds any missing full-width pages once. An existing single-widget page, such as **Media** for Emby, keeps its name. Pages fill the canvas. Swipe left for the next page or right for the previous one. Horizontal carousels keep their own scroll gestures. Start at either bezel to switch pages over a carousel. Tap the background at the middle of the left edge or press **Option-P** to open the page picker. The same widgets can occupy sections of a mixed layout. The Edge and both previews lay widgets out on Zurface’s 1920 × 540 reference canvas (540 × 1920 in portrait), then scale the entire page to fit the display. Opening a dashboard warms the configured collectors for every page. Page switches retain the widget views, and simultaneous previews and output share collectors and Mac telemetry history.

| Widget | Original views and controls |
| --- | --- |
| Emby | Playback wall, session details, stream bitrate, server activity, artwork, weekly viewing and release notes. |
| ComfyUI | Two-worker render wall, WebSocket step progress, queue and history, GPU and system memory, tap-to-reveal output with the original 15-second conceal timer. The selected worker appears first. |
| Unraid | Array and pool devices, disk I/O, CPU, RAM, network history and running containers with icons and charts. |
| Proxmox | Cluster summary, nodes, VM and LXC counts, GPU telemetry on configured running guests, load history and paging. |
| oMLX | Live and historical metrics, animated decode rate, Mac specs, server picker, model inventory, load and unload controls, token usage and weekly graphs. |
| Ember Copper | The original Copper artwork and typography, workspaces and chats, live transcripts, plans and usage reports from the local Ember profile. |
| JSON | Install a package that specifies the field, then choose its JSON endpoint in the widget’s Settings. |

The views and their static assets live in `widgets/views`. Workbench sends connection settings and credentials directly to the corresponding bundled collector. Each collector publishes display data into a private temporary directory. Opening the same feed in Settings and on the display shares its collector. Visited pages retain their views and histories while the dashboard stays open. Leaving the page conceals ComfyUI output. Quitting the app stops its collectors.

## Run-DMD

Add **Run-DMD** to a page, then tap the dots to open its menu. Under **Animations**, open a Run-DMD card image created by HDD Raw Copy Tool (`.imgc`) or an uncompressed image (`.img`). The importer reads the image signature, so renamed copies work. It validates the frame directory before replacing the active card. Group and clip selections are shared across the widget’s placements.

Choose a group to browse its clips. Use **Preview** to play one immediately. **Playback** controls the clock interval, overlay layer, clip names and speed. **Clock**, **Messages** and **Display** control clock faces, scrolling text, dot color, brightness and scheduled standby. **Four-button menu** provides the board’s Exit / Previous / Next / OK interaction. With the panel focused, C opens the menu, A and B toggle their key texts, and D controls standby. Tap a sleeping panel to wake it.

The widget reads B134’s original artwork, frame indirection and transparency. Clock faces and panel effects are software recreations. Long frame delays use the empirical timing model from [RunDMD-Utils](https://github.com/Pwedge/RunDMD-Utils). The [firmware menu manual](https://swinks.com.au/manuals) describes the board’s original options. RF switching and external temperature probes require physical expansion hardware.

For a personal macOS build, pass `RUNDMD_IMAGE` to the packaging script with the path to your card. That build embeds the supplied image and creates a Run-DMD page on first use. The standard build accepts images through the widget menu.

## Manage widgets and build a package

Widget Studio lists installed widgets with their artwork, description and page usage. Open **Settings** on a card to manage its connections and jump to its placements. **Remove** clears that widget from layouts and the library while preserving saved connections. Use **Restore bundled widgets** to bring a bundled widget back.

Use **Download example** for a working ZIP containing `widget.json`, `icon.png` and an editing guide. Unzip it, edit the manifest and artwork in your own tools, and compress the files together. **Install package** accepts the ZIP or an existing declarative JSON package. Keeping the package ID updates the widget in place. PNG icons can be up to 512 × 512 pixels and 64 KiB. Configure credentials in the installed widget’s Settings.

System instruments share a roughly three-second telemetry sample. Readouts ease to each measured value over one second. Clocks and focus timers retain a one-second tick.

## Development

For frontend development with the Tauri CLI, run `npm ci` and `npm run dev`. Run `npm test` for the JavaScript and Rust tests.

### Build and install a release

On the signing Mac, with Rust, Xcode Command Line Tools and an official standalone Node 24+ distribution on PATH (or selected with `WIDGET_NODE`), run `./scripts/package-mac.sh`. It signs the app and its bundled Node runtime with the HORIZN INC Developer ID used by Ember, writes the ZIP under `dist/`, then replaces and opens `/Applications/Edge Workbench.app`. The installer verifies the staged copy before quitting a running dashboard and swapping the bundles.

The signing script selects Hrizn’s public certificate name and team ID. The private key stays in the signing Mac’s Keychain. Local key exports and credential files are excluded from Git by default.

To build and sign in separate sessions, run `./scripts/package-mac.sh --prepare-only`, then `./scripts/sign-mac.sh "dist/Edge Workbench.app"` in the signing session. To install an already signed bundle, run `swift scripts/install-mac.swift "dist/Edge Workbench.app"`. `SIGN_IDENTITY` selects a specific signing identity. `SIGN_IDENTITY=-` produces a local ad-hoc build in `dist/` and skips installation.

This release is an early preview. The detailed [product plan](docs/PLAN.md) tracks the intended catalog, service parity and package runtime. The initial package format supports declarative widgets. The six service dashboards use their original presentation assets and the bundled collectors.

Based on [Edge Starter](https://github.com/joshsorenson/edge-starter), distributed under the MIT license.
