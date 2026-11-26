<h1><img src="docs/brand/dashledge-icon.svg" width="58" align="middle" alt=""> &nbsp;<img src="docs/brand/dashledge-wordmark.svg" width="260" align="middle" alt="Dashledge"></h1>

**Put it on the ledge.** Dashledge turns the CORSAIR XENEON EDGE into a customizable touch dashboard for Mac. Give Apple Music the whole display, keep a Slack thread beside your calendar, or swipe to a page of live Mac and server metrics.

## Get started

1. Open the [releases page](https://github.com/dgruhin-hrizn/dashledge/releases/latest) for the latest build. For a Dashledge ZIP, expand it and move **Dashledge.app** to **Applications**. Quit an existing copy of Dashledge or its predecessor, Edge Workbench, before launching the new version.
2. Open **Settings → Pages & layouts**, add a page, and choose **Add widget**. Give one widget the whole screen or split the page into sections. Try the layout in **Live preview**.
3. In **General → Display**, select the EDGE and choose **Move to display**. Enable direct touch and grant Input Monitoring if macOS asks. Choose **Return to preview** to release the panel.
4. Swipe left or right to change pages. Over a carousel, start at either bezel. Tap the middle of the left edge or press **Option-P** for the page picker.

The menu-bar icon reopens Settings. You can also run the dashboard in a resizable window using **Show Window Preview**.

## What goes on the ledge?

| Widget | What you can see or do |
| --- | --- |
| AI Plan Monitor | See the tightest Claude or Codex allowance on a dial, when it resets, and whether your current pace runs it out before then. Each account shows its plan (Max, Pro, Plus…), its other windows, a reached limit and any banked Codex resets. An account without a reading says why, such as which profile to sign in to, and a reading that couldn’t be refreshed shows its age. The Edge shows readings only. Choose accounts or pin one in **Pages & layouts**, or set shared defaults in **Widget Studio**; both editors list each account’s status and offer **Check now**. Sign in to Claude Code or Codex on your Mac. Dashledge bundles Anthropic’s Claude Agent and TypeScript SDKs and OpenAI’s Codex SDK to read subscription windows without sending prompts. It also discovers named profiles in `~/.claude-NAME` and `~/.codex-NAME` with their provider settings file. Provider artwork from LobeHub ships inside the app. |
| Market Watch | Follow real-time IEX trades for US stocks and ETFs. Use **Edit list** to add or remove US tickers per placement. Stock and ETF logos load automatically from LogoAPI.sh, with ticker initials for missing artwork. Pre-market and after-hours trades carry a session label, and after-hours movement is measured from the last observed regular-session IEX price. Connect an Alpaca paper or live account in **Widget Studio → Market Watch** using its API key ID and secret. |
| Apple Music | Browse playlists by cover, search your library, and see what follows the current song in album or playlist order. Choose AirPlay speakers, adjust EQ, rate a track, or read lyrics saved with it. |
| Spotify | Browse playlists and recent plays, search for songs, add to the queue, switch playback devices, and watch a live audio spectrum. |
| Slack Workspace | Read mentions, direct messages, favorite channels, and thread replies in one full-screen view. Ten individual Slack widgets are also available for split layouts. |
| Mail & Calendar | Read recent Apple Mail or Spark Desktop inbox headers alongside your upcoming Mac calendar events. Filter individual calendars, swap the panes, and tap a meeting link to join. |
| Mac Shortcuts | Pin shortcuts from your Mac, choose each button’s color and icon, and arrange them in a different order on each page. Tap to run a shortcut and see when it finishes. |
| Apple Photos | Show your library, selected albums, or your iCloud Shared Photo Library on supported Macs. Choose Editorial montage, Instant prints, Filmstrip, Panorama gallery, or Daydream, where several photos drift and zoom across the screen. Set the speed and direction or tap to pause. |
| Mac instruments | Track CPU, GPU, memory, disk space, network throughput, power and thermals. Inspect individual network interfaces, mounted volumes, and Mac hardware details. Available counters depend on the Mac. |
| Emby | See active streams, artwork, and bitrates, and control playback. |
| Unraid | Check array health, storage activity, and containers. |
| Proxmox | Monitor cluster nodes, virtual machines, and guest GPU telemetry. |
| ComfyUI | Follow render queues and worker activity, and preview generated images. GPU load comes from the Crystools node, this Mac, SSH to the ComfyUI host (NVIDIA, AMD, Intel, Apple or Windows counters), or a Proxmox guest, whichever answers first. |
| oMLX | Watch live decode speed with request markers, memory split by loaded model, cache hits, and a week of usage. Load, unload and compare models by how they fit in memory. |
| Ember | View local workspaces, chats, plans, and usage. |
| Run-DMD | Turn the screen into a pinball dot-matrix clock with selectable animation groups and clips. |
| Everyday tools | Add local and world clocks, a focus timer, a scratchpad, or a widget backed by your own JSON endpoint. |

### Connect a service

Widget Studio and the layout picker group widgets by purpose. Studio opens with the first available category expanded. Use **Jump to section** or select a category heading to switch sections.

In **Widget Studio**, open the widget’s settings, choose **Add connection**, enter the server details, and select **Test**. Pick that connection in the layout inspector. Saved credentials are protected by the macOS Keychain. Existing installations retain their layouts and the Keychain item named **Edge Workbench Connections**.

The connection name is optional. Left blank, widgets show the name the server reports, such as Emby’s server name, Unraid’s host name or the Proxmox cluster, and otherwise the address’s host. Type a name to rename it everywhere that connection appears.

For Spotify playlists, search, and queue access, register `http://127.0.0.1:4848/callback` in your Spotify developer app. Select **Playlists → Connect Spotify** and enter the app’s Client ID. Allow system audio recording if you enable the spectrum analyzer. The Apple Music widget uses the Music app on this Mac. Allow macOS Automation access when prompted.

### Choose your Slack view

Open a Slack widget’s settings in **Widget Studio** and choose **Create workspace app**. Install the preconfigured Slack app in your workspace, copy its **User OAuth Token** from **OAuth & Permissions**, and paste it into **Connect workspace**. All eleven Slack widgets share that connection.

Use **Slack Workspace** for the full reader. For a split page, choose the widget that matches what you want to follow or control.

| To… | Add |
| --- | --- |
| Catch up on conversations addressed to you | Mentions or Direct Messages |
| Follow a channel, saved search, or single thread | Channel Watch, Keyword Watch, or Thread Monitor |
| Open a channel’s pinned items or saved links | Channel Pins or Channel Bookmarks |
| Find a coworker, set a timed status, or pause notifications | People Directory, My Status, or Quiet Hours |

### Set up Mail & Calendar

Add **Mail & Calendar** in Pages & layouts. Tap **Allow calendar access** on the widget. The agenda shows the next seven days from macOS EventKit. For calendars used in Spark, enable the same account under **System Settings → Internet Accounts → Calendars**. You can leave the Mail switch off.

Use the swap button beside **Calendar** to choose which pane comes first. Each placement remembers its own order. On narrow tiles the panes stack. Tap **Calendars** to show or hide individual calendars grouped by account. Each widget placement remembers its selection. Tap a date to filter the agenda.

In the **Inbox** pane, choose **Use Apple Mail** for the unified inbox, unread count, recent messages and compose. Approve the macOS Automation prompt to read inbox headers. Choose **Use Spark** to see the latest eight cached inbox messages and unread total across Spark accounts. Dashledge reads local message headers in read-only mode every 20 seconds while the mail view is visible. Tap a recent message to expand its header. Use pinned deep links to open specific conversations in Spark, or save recipients for one-tap compose. In Widget Studio you can switch clients or pin messages using Spark’s **Copy Deep Link** command.

### Load a Run-DMD card

Add **Run-DMD** to a page and tap the dot matrix to open its menu. Under **Animations**, load your own HDD Raw Copy Tool image (`.imgc`) or raw disk image (`.img`). Choose which groups can play, preview individual clips, or adjust the clock face, brightness, and playback interval. The original B134 animation artwork comes from the card you supply. The clock faces and panel effects are software recreations. Animation timing draws on [RunDMD-Utils](https://github.com/Pwedge/RunDMD-Utils).

### Add your own widget

Open **Widget Studio → Download example** for a working package and its guide, `README.md`, which is also in [`widgets/example/`](widgets/example/README.md). Edit the package and use **Install package** to add it. Keep its package ID to update an existing widget; its placements stay.

Every widget view runs in a sandbox. It can’t reach the network, your files, your credentials or other widgets. A package gets its data in one of two ways, and the install sheet says which before you confirm:

- **Declarative.** The manifest lists routes for Dashledge to poll on the connection you choose, and actions it may send when you tap. No package code runs outside the view.
- **Connector.** Package JavaScript runs in its own sandboxed context. It can reach only the connection’s address and the hosts the manifest names. Dashledge adds the saved credential itself.

Packages can also ask for Dashledge capabilities, listed at install: **settings** for each placement, edited in Pages & layouts or from the widget’s own gear; the shared on-screen **keyboard**; Dashledge’s **UI** styles; and this Mac’s CPU, GPU, memory and network readings (**mac.metrics**).

For widget authors, **Load unpacked package** runs a package straight from its folder and reloads it when files change. A connector widget’s page in Widget Studio shows its recent console output. `dashledge.d.ts` in the example declares the view and connector APIs for TypeScript.

## Development

Dashledge uses Rust, Tauri, and system WebKit. The Mac app bundles Node for its collectors. For local development, install Rust, Xcode Command Line Tools, and an official standalone Node 24+ distribution, then run:

```sh
npm ci
npm run dev
```

Develop each widget in its own Git worktree and branch from the latest `origin/main`. Test it there and open one pull request per widget targeting `main`. Once all widget PRs for the release have merged, sync a clean `main` checkout and run the following commands. You can run the signing step in a separate Mac Terminal session.

```sh
npm test
./scripts/package-mac.sh --prepare-only
./scripts/sign-mac.sh "$PWD/dist/Dashledge.app"
```

The signing script signs the app and its bundled runtime, verifies them, creates the release ZIP, and installs and opens the app. If you built in a custom output directory, pass the path to that directory’s app. For a personal build with a bundled Run-DMD card, set `RUNDMD_IMAGE` to your card image when preparing the bundle.

### Publish a macOS release

Run `node scripts/release-version.mjs 0.6.0` with the intended version, then merge the version changes and release content into main. From Mac Terminal run `./scripts/release-mac.sh`. The command checks out main, runs the JavaScript and Rust tests on the same Apple Silicon Mac that builds the app, signs with the HORIZN INC Developer ID, and notarizes using the `ember-notary` Keychain profile. It publishes the Apple Silicon ZIP and SHA-256 checksum under the matching version tag and verifies GitHub marks it Latest.

The authenticated GitHub CLI account needs permission to publish releases. Set `DASHLEDGE_NOTARY_PROFILE` to use a different notary profile. Public builds omit personal Run-DMD artwork.

**General → Updates → Automatically install updates** checks GitHub at launch and every 24 hours while Dashledge is running. A newer release downloads, verifies its checksum and HORIZN INC signature, replaces the app, and reopens it. Use **Check and install update** to run the same process manually. Install version 0.6.1 once to receive future updates this way.

## Upstream credit

Dashledge began as a fork of **Josh Sorenson’s Edge Starter**. Its macOS HID touch handling and mapping of touch coordinates to the XENEON EDGE display form the basis of Dashledge’s touchscreen controls. The upstream MIT copyright and license are retained. You can also find the project links in **Settings → About**.

[Dashledge on GitHub](https://github.com/dgruhin-hrizn/dashledge) · [Edge Starter on GitHub](https://github.com/joshsorenson/edge-starter) · [MIT license](LICENSE)
