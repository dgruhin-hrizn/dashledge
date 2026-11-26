# Ember widget: design rules

These rules apply to the Ember widget only. Follow them when changing its view.

The view follows two sources: the Ember app for the transcript and Plans, and the buildwithember.ai website for the Usage page, the rail and the wordmark.

## Sizing

The rail and Usage are sized in px on the 1920 × 540 reference canvas, as `calc(Npx*var(--u))`, where `--u` is `--px-scale` (4/3 on the Edge at 2560 × 720). Divide an Edge size by 4/3 for the value in `view/style.css`.

- **Primary reading:** the plan headroom number, at least 96 px on the Edge (72 px reference). It shows the window with the least room left across every account, with its account and reset time.
- **Secondary figures** (range totals, gauge values): 28 px or more on the Edge.
- **Labels, axis ticks, legends and notes:** 21 px minimum on the Edge (16 px reference). Use the UI font for these, not monospace.
- **Numbers never truncate.** A narrower placement drops figures, the heatmap or the per-account gauges before it shrinks a reading.
- **Hit areas** stay at least 44 × 44 px on the Edge.

## Look

- Colours follow the website's dark palette: page `#1b1a19`, cards `#262624`, hairlines `#3a3936`, clay `#e3936f` for accents, green, amber and red for remaining capacity.
- Titles and large figures use the serif (`Source Serif 4`, falling back to Iowan Old Style) with lining, tabular digits. Section labels are uppercase and tracked.
- Range and measure choices are segmented controls, as on Ember's own Usage page.
- The rail is a flat list. The chosen row sits on a raised fill with a clay icon, with no gradients or side stripes.
- The wordmark is the flame mark beside a lowercase serif "ember", with the mark about 1.3× the type.
- Rail icons are inline SVG symbols in `index.html`. Fonts load cross-origin from the sandboxed frame, so the view ships no web font.

Check a change at 2560 × 720 (native) and in compact placements on the reference canvas: about 940 × 520 and a narrow 620 × 520. Try every range, the Tokens and Cost switch, a day's breakdown, and an account with no 5-hour limit.
