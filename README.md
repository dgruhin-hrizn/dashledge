<h1><img src="docs/brand/dashledge-icon.svg" width="58" align="middle" alt=""> &nbsp;<img src="docs/brand/dashledge-wordmark.svg" width="260" align="middle" alt="Dashledge"></h1>

**Put it on the ledge.** Dashledge turns the CORSAIR XENEON EDGE into a customizable touch dashboard for Mac. Keep your music controls, live system metrics, and server dashboards on the touchscreen while you work on your main display.

## Get started

1. Open the [releases page](https://github.com/dgruhin-hrizn/dashledge/releases) for available builds. For a Dashledge ZIP, expand it and move **Dashledge.app** to **Applications**. Quit an existing copy of Dashledge or its predecessor, Edge Workbench, before launching the new version.
2. Open **Settings → Pages & layouts**, add a page, and choose **Add widget**. Give one widget the whole screen or split the page into sections. Try the layout in **Live preview**.
3. In **General → Display**, select the EDGE and choose **Move to display**. Enable direct touch and grant Input Monitoring if macOS asks. Choose **Return to preview** to release the panel.
4. Swipe left or right to change pages. Over a carousel, start at either bezel. Tap the middle of the left edge or press **Option-P** for the page picker.

The menu-bar icon reopens Settings. You can also run the dashboard in a resizable window using **Show Window Preview**.

## What goes on the ledge?

| Widget | What you can see or do |
| --- | --- |
| Mac instruments | Follow CPU, GPU, memory, disk, power, thermals, and network activity. Available counters depend on the Mac. |
| Spotify | Control playback, browse playlists, manage the queue, and display a live audio spectrum from the Spotify desktop app on your Mac. |
| Emby | See active streams, artwork, bitrates, and server activity. |
| Unraid and Proxmox | Check array and pool activity, containers, cluster nodes, VMs, and guest telemetry. |
| ComfyUI and oMLX | Follow render queues, preview outputs, watch model decode rates, and manage loaded models. |
| Ember Copper | View local workspaces, chats, plans, and usage. |
| Run-DMD | Turn the screen into a pinball dot-matrix clock with selectable animation groups and clips. |
| Everyday tools | Add local and world clocks, a focus timer, a scratchpad, or a widget backed by your own JSON endpoint. |

### Connect a service

In **Widget Studio**, open the widget’s settings, choose **Add connection**, enter the server details, and select **Test**. Pick that connection in the layout inspector. Saved credentials are protected by the macOS Keychain. Existing installations retain their layouts and the Keychain item named **Edge Workbench Connections**.

For Spotify Connect, register `http://127.0.0.1:4848/callback` in your Spotify developer app, then select **Playlists → Connect Spotify**. Allow system audio recording if you enable the spectrum analyzer.

### Load a Run-DMD card

Add **Run-DMD** to a page and tap the dot matrix to open its menu. Under **Animations**, load your own HDD Raw Copy Tool image (`.imgc`) or raw disk image (`.img`). Choose which groups can play, preview individual clips, or adjust the clock face, brightness, and playback interval. The original B134 animation artwork comes from the card you supply. The clock faces and panel effects are software recreations. Animation timing draws on [RunDMD-Utils](https://github.com/Pwedge/RunDMD-Utils).

### Add your own widget

Open **Widget Studio → Download example** for a ZIP containing a manifest, icon, and editing guide. Edit the package and use **Install package** to load it. Keep its package ID to update an existing widget.

## Development

Dashledge uses Rust, Tauri, and system WebKit. The Mac app bundles Node for its collectors. For local development, install Rust, Xcode Command Line Tools, and an official standalone Node 24+ distribution, then run:

```sh
npm ci
npm run dev
```

Run `npm test` for the JavaScript and Rust suites. To prepare a macOS bundle and sign it in a separate Terminal session:

```sh
./scripts/package-mac.sh --prepare-only
./scripts/sign-mac.sh "$PWD/dist/Dashledge.app"
```

The signing script signs the app and its bundled runtime, verifies them, creates the release ZIP, and installs and opens the app. If you built in a feature-specific output directory, pass the path to that directory’s app. For a personal build with a bundled Run-DMD card, set `RUNDMD_IMAGE` to your card image when preparing the bundle.

## Upstream credit

Dashledge began as a fork of **Josh Sorenson’s Edge Starter**. Its macOS HID touch handling and mapping of touch coordinates to the XENEON EDGE display form the basis of Dashledge’s touchscreen controls. The upstream MIT copyright and license are retained. You can also find the project links in **Settings → About**.

[Dashledge on GitHub](https://github.com/dgruhin-hrizn/dashledge) · [Edge Starter on GitHub](https://github.com/joshsorenson/edge-starter) · [MIT license](LICENSE)
