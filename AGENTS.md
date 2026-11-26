# Dashledge macOS builds

Test the changes and prepare the integrated app with `scripts/package-mac.sh --prepare-only`. Use the build's actual output directory and preserve the user's bundled Run-DMD card when preparing their personal build.

For signing and installation, use the repository's `scripts/sign-mac.sh` with the absolute path of the prepared app. The Spotify workflow uses this Mac Terminal command:

```sh
~/edge-workbench/scripts/sign-mac.sh "$HOME/edge-workbench/dist/spotify-touch-keyboard/Dashledge.app"
```

Substitute the actual feature output directory for each build. The script uses the HORIZN INC Developer ID, signs and verifies the bundled Node runtime and app, writes the ZIP, installs into /Applications, and relaunches Dashledge.

If the build shell cannot access the Developer ID, leave the prepared app ready and provide the single pasteable command for the user's Mac Terminal. An ad-hoc signature does not complete this workflow. Confirm the installer reported `Installed and opened /Applications/Dashledge.app` before reporting success.

## Full-screen widget rendering

Render new full-screen widgets directly at the Edge or preview window’s actual viewport size. Scaling a 1920 × 540 dashboard to 2560 × 720 magnifies already-rendered text by 4/3 and can soften glyphs. Use responsive layout and typography to achieve the desired physical size.

- In `ui/dashboard.js`, route the standalone widget through `data-native-viewport`. The shared `fitDashboard` in `ui/general.js` sets the frame to the destination width and height, positions it at the origin, and clears the scaling transform. Embedded widget frames should fill that viewport. Let the browser handle display pixel density.
- Full-screen pages are edge-to-edge, with zero outer border and corner radius. When switching to a split page, restore its existing reference-canvas layout.
- When changing widget sizing, verify through both `edge.html` and `preview.html`. At 2560 × 720, check that the dashboard and any full-screen inner frame measure 2560 × 720 CSS pixels for a host of that size, have no scaling transform, and receive taps at the displayed control coordinates. Also check a resized preview and the transition back to a split page.

## Touch keyboard

Use Spotify’s full-screen search keyboard for text entry on the Dashledge touch display. Open it with `openTouchKeyboard` from `ui/search-keyboard.js`. Spotify, Apple Music, and Slack share this entry point and the keyboard sheet styles in `ui/spotify.css`.

Keep the input and task content on the left and the four-row keyboard on the right on the Edge. Preserve Shift, symbols, Backspace, Space, caret and selection editing, physical keyboard input, and touch targets of at least 44 CSS pixels on the Edge. Give the primary key the action’s name, such as Search or Follow. When changing the keyboard, exercise a touch submission and a physical Enter submission through a consuming widget.
