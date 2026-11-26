# XENEON Edge for macOS — product and engineering plan

**Review draft · November 25, 2026**  
Working repo name: `edge-workbench`. First milestone: a finger can switch to page nine, control Emby, and return to a five-widget Mac dashboard without moving the main-display pointer.

## The foundation

Fork [joshsorenson/edge-starter](https://github.com/joshsorenson/edge-starter), retain its MIT notice and upstream remote, and give our signed app its own bundle ID. Keep its Rust/Tauri 2 host for HID touch, window placement, hot-plug, menu bar and login behavior. Use TypeScript, CSS and the system WebKit renderer for the dashboard and editor. This preserves the six existing web interfaces. Use a small Swift or Objective-C bridge only for macOS APIs that are awkward from Rust. The starter already includes Spotify and system-stat examples. Treat them as implementation leads to validate on Apple silicon.

The host lives in its own repo outside Ember. Each custom widget stays in its current repo and can ship both a Zurface bundle and an Edge package from shared sources. Keep local hostnames, credentials, captured media, transcripts and snapshots out of the fork. Store credentials in Keychain and keep their use on the collector side.

## One app from install to quit

Ship one signed, notarized macOS application with a plugin manager and a starter set of independently versioned widget packages. Preinstall the starter packages through the same loader used for later installations. Git repositories and frontend tooling are development inputs. A clean Mac can run the release without Node, npm, Homebrew, Git, a terminal, or per-widget installations. The app works independently of Zurface.

Keep macOS-specific primitives and scheduling in the Rust host. Package service-specific parsing, subscriptions, actions and configuration with each plugin. The host owns connection lifetimes, timers, caches, cancellation and reconnect backoff. Widget instances subscribe to the same source by connection ID. Adding the same Emby server to three pages opens one shared data feed. Disabling a source closes its tasks and sockets; quitting closes all of them. WebKit may create OS-managed rendering processes. Existing remote servers continue running independently.

On first launch show the local Mac dashboard. Guide the user through enabling touch, choosing the display, and optionally starting at login. Settings → Widgets → Connections provides Add, Test, Save, Edit, Disable, Retry and Remove. Each integration supplies its own form: ComfyUI worker names and URLs, Emby server and API key, Unraid endpoint and credentials, Proxmox host and token, oMLX endpoint, or Ember's local workspace location. Use native folder pickers and Keychain for secrets. Show connection state, last successful update and a specific recovery action. Keep each tile's view options in its layout inspector. Changing a connection updates all subscribed tiles without restarting the app.

For existing installations offer an optional migration screen. Detect known widget launch agents and settings, show the exact sources to import, and verify each plugin connection against fresh data. Offer to turn off its matching legacy agent only after that source is working and the user selects the cutover. Explain which Zurface widgets depend on it. Preserve the previous configuration and offer Restore in the same screen. Keep unrelated Node processes outside the migration.

## Independently installable plugins

A widget package contains a manifest (stable ID, publisher, version, supported host API range and capabilities), local HTML/CSS/JS assets for each supported size, a settings schema, and optional provider logic. Use the same package for every instance of that widget. Plugins live in Application Support outside the signed app bundle. Each existing widget repo builds and releases its own package.

Proposed first implementation: run provider JavaScript in a host-managed JavaScriptCore context separate from the WebKit view. Expose a narrow, asynchronous bridge for declared HTTP/WebSocket sources, user-selected file access, secret-backed requests, scheduled updates, system-metric subscriptions and permitted commands. The runtime supplies these APIs explicitly; plugins do not depend on Node, run shell scripts or load arbitrary native libraries. Put execution deadlines and resource limits around provider work; prototype termination of a stuck provider before committing to that runtime. Keep data available when individual views unmount, according to the source's collection policy.

Settings → Widgets offers Browse, Install from File, Configure, Update, Disable and Remove. Verify publisher signatures, compatibility and requested permissions before activation. Show added permissions for approval on update. Stage and validate upgrades, migrate versioned settings, then switch packages atomically. Keep the last working package and recoverable settings for rollback. Preserve layouts by plugin and instance ID; a disabled or missing package shows a recoverable placeholder. Updates take effect without restarting the host or disrupting other widgets.

A new service, visual, parser or command implemented with existing bridge capabilities ships as a plugin release. A genuinely new privileged OS primitive, such as the first integration needing an unsupported macOS framework, requires a host capability release. Publish the SDK, package format and sample plugin with the first usable host. The SDK may use development tools; installing its output requires only the app.

Release gate: freeze a signed host build, then independently build and install a previously unknown plugin through Settings. Connect a source, place it twice, update it while another widget stays live, recover from a broken update, and disable and reinstall it. Verify the same host binary throughout, preserved settings and layouts, and zero per-plugin background services.

## Widget Studio and the first-time author

Add Create Widget and Remix to the Mac widget library. The first-run goal is a useful tile on the physical panel before the author opens an editor. Ship three starter designs: a number with a sparkline, a status list, and a now-playing card. The visual editor and SDK produce the same package, so the author can move from visual editing to source without starting over. Remix copies the design and example data under a new ID. Personal connection settings, credentials and captured live data stay on the author's Mac.

First tutorial: build a free-space tile. Choose Number + chart, select the built-in disk source, pick a volume and the available-bytes field, choose automatic GB/TB formatting, and name it Free space. The canvas previews the actual tile at compact and wide sizes. Preview a disconnected volume, then choose Add to Page. Studio generates the manifest, size declarations and settings form. History comes from the host's metric subscription.

For a simple external service, choose HTTP JSON, enter a URL, test the response, and pick fields from a tree. Support arrays, numeric formatting, timestamps, refresh cadence and a credential field backed by Keychain. Turn the server address into a user setting so each recipient connects their own server. A developer who needs custom interaction can open the generated HTML/CSS/JS folder in their editor and use live reload, sample data and a console pointing to the failing file or field. Custom provider code is optional. Include short, runnable examples for a button, a list and a WebSocket progress feed.

Local drafts run with an explicit developer opt-in and a capability preview. Export bundles portable assets and synthetic examples. Propose one-click publisher identity setup and package signing in Studio for sharing, with the private key held in Keychain. A recipient opens the package, sees the publisher and capabilities, then configures their own connection. Catalog publication is optional. Document how to export a design without credentials, rotate a publisher key, and update a package while retaining its ID.

Deliver Disk Free Space as the first end-to-end Studio template before rolling out the other templates. Usability gate: give a first-time author a clean install and the one-page tutorial. Within ten minutes, they should create the disk widget, put it on their Edge and export it without Terminal or assistance. On a second Mac, install the export, select a different volume and verify that no source-machine settings or secrets traveled. Track time and where the author needed help; the ten-minute target is a design goal until tested.

## Pages and placement

A page has a stable ID, title, order and a list of placements. Each placement has a separate instance ID, widget ID, rectangle and settings. Two disk widgets can monitor different volumes. Page count follows the saved list. Reordering or renaming a page preserves its widgets and settings. Persist versioned layouts atomically, with a last-good copy for recovery.

Start each page by choosing a visual layout preset. Match the screenshot's One, Two, Three and Four (equal full-height columns), Six (three columns by two rows), and Featured (one large section on the left and two stacked on the right). Add Five as a one-click preset for the CPU, GPU, Memory, Disk and Network page shown in the screenshot. Keep geometry separate from content: the Five preset creates empty sections; the Mac dashboard template fills them with those instruments.

Represent sections as proportional rectangles or weighted splits so thirds and fifths both land on clean, shared pixel boundaries. Give each section a stable ID independent of its widget. Clicking a section exposes add, replace, remove widget, or split horizontally/vertically. An empty section remains selectable. Enforce each widget's minimum size and show compatible compact presentations.

On a populated page, preview the proposed placement using existing widgets in reading order, preserving instance IDs and per-widget settings. If widgets overflow or cannot fit, show them explicitly and let the user reassign them or cancel before applying. Undo restores the entire preceding arrangement and its assignments.

On the Edge, a slim edge handle opens a touch page picker. A swipe starting inside the handle changes pages; drags starting inside a widget stay with that widget. Tap a compact widget's expand affordance for full-page detail and return to the same place. Preserve chat scroll position, carousel selection and page state. Clear revealed private thumbnails when leaving a page. Provide reduced motion, large hit targets and a touch calibration view. Measure hit regions in displayed coordinates, including inside embedded widgets.

## Settings on the main display

Use the supplied Zurface Settings screenshot as the reference. Keep General, Layouts and Widgets in the left sidebar. In Layouts, put named page tabs and Add Page above the proportional display map, a searchable widget library with category filters on the right, contextual section controls directly below the map, and a persistent strip of miniature preset diagrams along the bottom. Give page tabs overflow navigation as the list grows. Keep Reset Page and Undo within reach.

Drag a widget from the library onto a section, or select the section and click the library's add control. Ordinary placements update the display immediately and support Undo. Preset changes that displace widgets get the placement preview described above. General covers display, touch, appearance and motion. Widgets manages installed versions, source settings, connection tests and credentials.

## System instruments and Spotify

Use the supplied five-card composition as the first preset. Align the numerals, baselines and timeline lengths across cards; use one accent for activity and a second color only when it distinguishes a series. Detail views should explain peaks and units. Preserve visible data gaps across sleep or disconnect.

| Widget | Compact or standard face | Expanded interaction |
| --- | --- | --- |
| CPU | Total utilization, 90-sample trace, recent peak | Per-core activity grouped by efficiency/performance where topology is available |
| GPU | Actual device name, utilization and recent peak | Larger history; validate the device counter on Apple silicon. Show unavailable when the OS supplies no usable reading |
| Memory | Used versus physical memory and pressure state | Wired, compressed, active and swap. Label estimates and avoid double-counting unified GPU memory |
| Disk | Selected volume, segmented capacity, free space | Touch volume picker; show read/write rate separately where a backing-device counter can be mapped. Handle shared APFS container space |
| Network | Download and upload rates with distinct traces | Choose interface or aggregate, label independent scales, handle resets and avoid double-counting VPN traffic |
| Spotify | Artwork, track and artist, previous, play/pause, next | Larger art, elapsed/duration and scrubbing where supported. Start with local Spotify control and request Automation only when used; treat account-backed likes as a later option |

## Porting the six existing widgets

| Widget | First port | Smaller presentation |
| --- | --- | --- |
| Emby | Full poster carousel, detail, release notes and active streams. First proof of precise layered touch | One playing session plus total streams |
| Ember | Live chat, history, tools, settings, plans and usage, including scrollback and return-to-live | Active chat or plan step; tap to expand |
| ComfyUI | Both workers, CUDA/GPU panels, queue, progress, private previews | One selected worker with node progress and VRAM; preview stays hidden until revealed |
| Unraid / Unraid | Array, pools, disk alerts and running containers with icons | Alerting disk and array free space |
| Proxmox | Host and guest status, CPU, memory and activity | One node and its busiest guest |
| oMLX | Decode rate, model status, usage and existing model controls | Current model and live tokens/sec |

Introduce a small host contract for snapshot subscriptions, visibility, size and allowed actions. Use the existing collectors as behavioral references and recorded fixtures to test their plugin replacements. Every ported widget must work with its legacy collector stopped and its snapshot files absent. Replace Zurface-specific touch maps with the new event path. On the first port, explicitly prove touch routing into nested DOM content, scroll containers and overlaid controls. Restrict native commands by widget capability and keep released packages pinned to known versions.

## Zurface parity baseline

Reviewed November 25, 2026 against the [product page](https://zurface.app/), [widget authoring guide](https://zurface.app/help/widgets/), the supplied layout screenshot and the installed 0.6.0 manifests, SDK declarations and widget resources. The baseline contains **39 bundled widget entries**, distinct from the six custom integration repos. All rows below are planned acceptance criteria. A first hardware demo can ship early; claiming replacement parity requires passing the full baseline.

### Built-in catalog

Each named widget must be independently discoverable and placeable, including variants backed by a shared provider. Use original implementations and artwork we can distribute. Run each row in window preview and on the Edge, with representative authorized, empty and offline data where applicable.

| Family | Required entries | Acceptance |
| --- | --- | --- |
| Mac performance | CPU, GPU, Memory, Disk, Network activity, System Monitor, This Mac | Compare individual tiles and the combined monitor against the same samples. Pick different volumes in two instances. Show machine name, OS, cores, installed RAM and uptime. |
| Diagnostics | Disk Activity, Network Details, Top Processes | Select a drive and see read/write rates and histories. Inspect addresses, state and per-interface rates; enable an optional latency probe. Switch process ranking between CPU and memory. |
| Music | Now Playing, Spotify Album Artwork, Spotify Controls, Spotify Tracks | Place combined and separate artwork, transport and track-list widgets. Exercise playback, seek, skip, shuffle, repeat, volume, mute, local favorites and recent tracks. Open a Spotify track, album or playlist link. Test disconnected and missing-art states. |
| Audio | Audio Controls | Select output, change volume and mute. Enable an opt-in microphone level meter and recover from denied access. |
| Everyday | Today, Calendar Agenda, Tasks, Deep focus, Scratchpad, Weather | Show local date/time with optional seconds, next seven days of calendar events and meeting join. Complete a reminder. Start, pause, reset and change the shared focus timer. Edit the shared scratchpad. Search for a weather location, persist it per instance and show its forecast. |
| Launchers and developer tools | Quick Launch, Apple Shortcuts, Project Status | Choose and launch a Mac application; list, refresh and run a named Apple Shortcut. Choose a local Git project, report branch, latest commit and changes, and inspect a selected build log. |
| AI overview | AI Activity | Read local Claude and Codex records, switch provider and session, refresh, and distinguish stale or missing records. Validate without Ember running. |
| Claude Code | Claude · Activity, Claude · Usage, Claude · Input Tokens, Claude · Output Tokens, Claude · Cached Tokens, Claude · Context, Claude · Usage Limits | Independently place and configure all seven views. Check recent operations, activity duration/failure, token breakdown, context and available limit windows/reset times against known local fixtures. |
| Codex | Codex · Activity, Codex · Usage, Codex · Input Tokens, Codex · Output Tokens, Codex · Cached Tokens, Codex · Context, Codex · Usage Limits | Repeat the seven-view test against Codex fixtures. Two copies can follow different sessions; an unavailable quota reads as unknown. |

### Host and distribution

| Area | Acceptance in the replacement |
| --- | --- |
| Setup and preview | Launch account-free from a signed, notarized drag-install DMG. Publish a checksum and check for app updates in the app. With no Edge attached, open a normal resizable Mac preview. With USB data attached, guide Input Monitoring setup and exercise direct touch. |
| Platform targets | Track macOS 13+ and both Apple silicon and Intel as upstream distribution targets. Build and test the minimum OS and both architectures before advertising support; upstream itself describes Intel runtime verification as pending. Record any deliberate support or pricing difference separately. |
| Orientation and touch | Run a portrait and a landscape page at the selected macOS display rotation. Swipe pages, long-press to rearrange on the panel, and open settings from the edge. Disambiguate page gestures, reordering, nested scrolling and normal taps on hardware. |
| Layout editing | Seed editable Performance, Everyday and Music pages. Exercise the preset strip, resizing, stacking, splits, drag/drop, instance selection, page reset and undo. Check independent widget copies and persistence after relaunch. Test page nine and beyond. |
| Appearance and library | Live-update primary and accent colors, muted text and clock seconds. Search and filter the widget library by category, including custom categories, and manage included and installed packages from Settings. |
| Local operation and support | Keep layouts and instance settings locally. Prompt for individual service/macOS permissions in context; show actionable errors when denied. Provide authoring help and a support path that lets users review diagnostics before sharing. |

### Widget API v1 compatibility

Provide an in-app import path for existing HTML/CSS/JS widget folders. Implement the documented external behavior with our own compatibility layer. Native plugin capabilities and Zurface-compatible imports retain distinct permission semantics.

| Contract | Acceptance fixture |
| --- | --- |
| Install and identity | Start with the guide's MIT counter ZIP. Extract and install the folder, inspect permissions, place it via the library, and invoke Layouts with ⌘L. Validate API version, stable ID, entry, author, version and permissions; preserve display name, category, symbol, preferred and per-board widths. Cover source packages that share an ID, including an explicit bundled override with a route to restore the original. |
| Edit, reload and share | Offer actions to inspect included widgets and open the installed custom folder. Edit a caption, press ⌘R, then update under the same ID and install a renamed copy under a new ID. Support portable ZIP sharing, manual package replacement, docs and working editable counter and CPU examples. The app and its plugins have separate update lifecycles. |
| State and storage | Inject both Zurface and Zeon globals. Deliver initial state, subsequent changes and a roughly one-second visible tick; unsubscribe cleanly. Expose time in milliseconds, stable instance ID, clock preference and theme. Register two counters, increment them separately, switch pages, unload, reload and relaunch. Their saved string values must remain independent. Focus and notes are intentionally shared. |
| UI compatibility | Resolve the documented local theme stylesheet and SDK resource paths used by supported packages. Test live color variables, semantic buttons and labelled inputs, disabled controls, 44-point targets, and wide, short, narrow and portrait layouts. Render missing metrics distinctly from zero. |
| Permission-scoped data and actions | For every permission and command below, exercise an allowed fixture, denied or missing permission, and invalid arguments where applicable. Check snapshot fields, units and absence rules against the installed declarations. Commands resolve or reject asynchronously with an actionable message. Cover multiple Spotify actions individually. |
| Networking | Import exact HTTPS origins from the manifest; allow browser fetch with the declared network permission and normal CORS. Test an allowed origin, an undeclared origin and CORS rejection. The separately approved native LAN connection for Emby or ComfyUI must never silently grant imported web content additional access. |
| Validation and diagnostics | For v1 imports, exercise the documented 10 MB package, 250-entry and 16 KB manifest bounds, ID syntax, missing entry, symlink and path traversal rejection. Test missing APIs in standalone preview, failed commands, clipped controls and wrong-folder edits. Produce a clear diagnostic inside Settings. Distinguish descriptive legacy author metadata from a verified publisher identity. |

**Permission inventory (14).** `metrics`, `focus`, `notes`, `shortcuts`, `storage`, `network`, `spotify`, `audio`, `calendar`, `reminders`, `activity`, `automations`, `project`, `ai`.

**Command inventory (23).** `ai.refresh`, `spotify.connect`, `spotify.control`, `audio.volume`, `audio.mute`, `audio.output`, `audio.microphone`, `calendar.connect`, `calendar.join`, `reminders.connect`, `reminders.complete`, `activity.latency`, `automations.refresh`, `automations.run`, `project.choose`, `project.buildLog`, `project.refresh`, `focus.toggle`, `focus.reset`, `focus.setMinutes`, `notes.set`, `shortcuts.launch`, `storage.set`.

**Release evidence.** Track each catalog entry, host row and SDK fixture as planned, implemented or verified, with its plugin/host version and a reproducible test or hardware result. Recompare the two public pages and installed inventory before cutover. Record any intentional departure explicitly. Our account-free setup, unlimited-by-design page list, visual authoring, Keychain-backed connections and independent plugin updates remain product requirements.

## Build sequence and acceptance

1. **Hardware and signing.** Create the fork after plan review. Build the unmodified baseline, then give the app a stable signing identity. Test Input Monitoring, mixed Retina/1× placement, sleep/wake, USB reconnect, pointer independence and handing the device back on quit. Use only one touch host at a time during physical tests.
2. **Pages, editor and the first real port.** Build the page store, placement editor, gallery, Emby plugin provider and in-app connection form. Install the release on a clean macOS account without developer tools. Configure Emby entirely in Settings, restart, confirm automatic reconnection, and verify quit stops sampling. Demonstrate twelve pages; add, reorder, delete, relaunch and recover them. Touch a carousel arrow exactly once, open a poster, and swipe between pages without stealing its carousel gesture.
3. **Mac dashboard and media.** Deliver all five system widgets plus Spotify. Demonstrate five instruments side by side, two independently configured disks, and a mixed Spotify/system page. Compare counters against macOS readings over the same interval; test stopped Spotify, unavailable GPU counters and offline interfaces.
4. **Port the other five dashboards.** Bring over Ember and ComfyUI first for streaming and privacy, followed by Unraid, Proxmox and oMLX. Compare identical captured fixtures in both hosts and live-test the touch actions that previously failed.
5. **Complete the parity catalog and SDK.** Deliver the remaining stock widget families as plugins, the v1 importer and the host workflows above. Run the compatibility fixtures with the same signed host.
6. **Daily-driver cutover.** Exercise Settings-based migration and restore with the legacy collectors stopped during plugin validation. Check every widget, login launch, credential persistence, offline recovery and quit without terminal steps. Measure idle, Mac dashboard, active chat, five-stream Emby and two-worker rendering. Record host plus WebKit and collector CPU, memory, wakeups, response latency and memory after repeated page switches. Compare with Zurface under the same workload. Keep it available as a rollback until the new host passes an unplug/replug and overnight run.

Start visible system graphs at one sample per second and disk capacity at ten seconds. Use bounded histories, one sampler per source, event-driven playback/chat/render updates when available, and suspend off-page drawing. Keep collecting only where history or alerts justify it. Establish absolute CPU and RAM targets after the baseline on the target Mac. Aim for under 100 ms from tap to visual feedback, tested on the panel.

## First review

Approve or revise three defaults: Rust/Tauri plus WebKit; a preset-first section editor with an edge-only page gesture; and Emby plus the five-card Mac dashboard as the first hardware demo. Naming, app icon, and final visual treatments can follow the interaction prototype.
