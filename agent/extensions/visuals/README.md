# Tool visuals

One local Pi extension for tool frames, syntax highlighting, diffs, codemode, web search, the header, footer, and working-time display. Run `/visuals` to change the diff layout or timer setting. Config lives in `~/.pi/agent/visuals/config.json`; on first load, the old `wierd-facelift` config is copied over if present.

## Where to change things

- `common/tool-frame/index.ts` owns the corners, rails, rules, widths, and status colours for every tool box. Change a border there.
- `shared/tool-heading.ts` owns how a tool name and its arguments become a framed heading. A renderer supplies argument values, colours, and optional continuation lines; it doesn't draw the heading itself.
- `builtin-tools.ts` contains each built-in tool's `renderCall` argument choices, result metadata, and body rendering. Codemode and web search have their own renderer modules. All of them use the same frame and heading helpers.
- `index.ts` only registers those modules. The footer, header, timer, highlighting, diff, and settings helpers live alongside the tools that use them.

The built-in tool renderers and their shared diff, frame, and settings code were adapted from `@wierdbytes/pi-facelift` 0.6.4 and `@wierdbytes/pi-common` 0.4.1. Both are MIT-licensed; their licence files are in this directory and `common/`. Tool execution still delegates to Pi's built-in tools.

Run `npm run check` from `agent/extensions/` for formatting, type-aware lint, type checking, and the ported tests. Tests use a temporary agent directory, leaving your config alone.

## Rendering performance

Run `npm run bench:render` from `agent/extensions/` to compare repeated redraws with explicit invalidations. It uses synthetic 160-column results (an 80-line highlighted read, a 40-line script, 60 search links, and 80 JSON items), so it doesn't measure the terminal or model latency. Shiki is warmed before the timings start. To collect a Node CPU profile of the benchmark worker, run `NODE_OPTIONS='--cpu-prof --cpu-prof-dir=/tmp' npm run bench:render`.

In the initial profile, rendering an unchanged nested read called `setExpanded(false)` every time, rebuilding its 80-line result (~0.6 ms); truncating all its ANSI rows again for the grouping rail added ~2.8 ms. Guarding the expansion change and clipping the single padding column brings the grouped redraw to ~0.1 ms on the same machine. Completed web searches, script input, and generic highlighted output now cache their lines between invalidations; partial search results still redraw the spinner. These are local benchmark figures, not a promise about whole-screen frame times.
