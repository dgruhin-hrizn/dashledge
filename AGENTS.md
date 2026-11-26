# Widget development

For each new widget or update to an existing widget, create a dedicated branch and Git worktree from the latest `origin/main`. Implement and test that widget in its worktree, then push the branch and open one pull request targeting `main`.

Merge every widget PR intended for a release before signing. Sync a clean `main` checkout to the merged revision, run `npm test`, and prepare a fresh app from that checkout. For a public release, follow the release procedure below.

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

1. Choose the stable version and run `node scripts/release-version.mjs <version>` from the repository root to update the Node, Cargo, and Tauri manifests and lockfiles together. Merge the version bump and every change intended for the release into `main` and confirm they are on GitHub.
2. Run `~/edge-workbench/scripts/release-mac.sh` from Mac Terminal for every public release. This is the reusable publishing command. It builds from a clean checkout of GitHub’s `main`, runs the full test suite and builds the Apple Silicon app on macOS, signs with the HORIZN INC Developer ID, and notarizes the public app. Keep personal Run-DMD artwork out of the release archive.
3. Report publication complete once GitHub’s `releases/latest` endpoint returns the matching `v<version>` tag and the release contains the Apple Silicon ZIP and its SHA-256 checksum. Include the published release URL. Dashledge uses this same endpoint for update checks.

# Dashledge macOS builds

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
