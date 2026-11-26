# oMLX widget: sizing for comfortable reading

These rules apply to the oMLX widget only. Follow them when changing its view.

Sizes are CSS px on the Edge at 2560 × 720. The stylesheet writes them on the 1920 × 540 reference canvas as `calc(Npx*var(--px-scale,1))`, so divide by 4/3 for the value in `view/style.css`.

- **Primary reading:** 96 px or larger. This is the live decode speed on Overview.
- **Secondary figures** (stat tile values, memory total, model and card names, headroom): 28 px or more. Stat tile values are about 50 px.
- **Body text, labels, legends, captions and chart axis labels:** 21 px minimum, with nothing smaller on the Edge. Use the UI font, not monospace, at these sizes.
- **Truncate names, never numbers or units.** A model name may wrap to two lines or shorten with "…". Counts, times, rates and sizes stay whole, as in the activity chip and the memory legend. A legend shows enough of each name to tell models apart.
- **Fill the space.** When a card has room, enlarge its reading before adding padding. When a column is too narrow for its readings, rebalance the columns instead of shrinking type.
- **Hit areas** stay at least 44 × 44 px.

Check a change in the full Edge viewport (2560 × 720) and in the compact, narrow, short and strip layouts. Nothing should overflow, overlap or truncate a number. Use real model names, which are long (for example `Qwen3.8-Flash-Next-UD-Q4_K_XL`).
