# Tool visuals

One local Pi extension for tool frames, syntax highlighting, diffs, codemode, web search, the header, footer, and working-time display. Run `/visuals` to change the diff layout or timer setting. Config lives in `~/.pi/agent/visuals/config.json`; on first load, the old `wierd-facelift` config is copied over if present.

Tools without a custom renderer, including MCP's generic tools, use the same open-right frames as the built-ins. The fallback keeps readable tool labels, arguments, status colours, highlighting, image handling, and expansion. Registered tool-specific renderers and extensions' self-framed MCP UIs take precedence.

Collapsed result bodies show 40 rows by default, except `read` and `grep`, which show 10. Override any tool by name in `previewLines`:

```json
"previewLines": { "default": 40, "read": 10, "grep": 10, "bash": 20 }
```

Codemode keeps each nested tool's own preview intact. Its `previewLines.codemode` limit applies only to the script output, with the hidden output-row count inside that frame. Wrapped display rows aren't source-file lines; nested tool boxes aren't counted as hidden output. The full-output path stays visible.

Ctrl+O expands results without the preview limit. The same config also holds `highlight` (Shiki theme, maximum characters, cache size), `diff` (theme, preset, colour overrides, split widths, cache size), `icons`, `imageProtocol`, `quoteUrl`, `diffLayout`, and `showWorkingTime`. Change the file and run `/reload` for theme, diff, icon, or timer changes; preview limits are picked up by the next result. Visual preferences no longer read `FACELIFT_*`, `DIFF_*`, or `PI_QUOTES_URL` environment variables. Pi's `PI_AGENT_DIR` and terminal-identification variables still control where settings live and which image protocol works.

## Where to change things

- `common/tool-frame/index.ts` owns the corners, rails, rules, widths, and status colours for every tool box. Change a border there.
- `shared/tool-heading.ts` owns how a tool name and its arguments become a framed heading. A renderer supplies argument values, colours, and optional continuation lines; it doesn't draw the heading itself.
- `builtin-tools.ts` contains each built-in tool's `renderCall` argument choices, result metadata, and body rendering. Codemode and web search have their own renderer modules. All of them use the same frame and heading helpers.
- `fallback-renderer.ts` supplies shared styling for generic tools; `shared/tool-renderer-patch.ts` chooses specialised renderers first and leaves tool definitions and execution untouched.
- `index.ts` only registers those modules. The footer, header, timer, highlighting, diff, and settings helpers live alongside the tools that use them.

The built-in tool renderers and their shared diff, frame, and settings code were adapted from `@wierdbytes/pi-facelift` 0.6.4 and `@wierdbytes/pi-common` 0.4.1. Both are MIT-licensed; their licence files are in this directory and `common/`. Tool execution still delegates to Pi's built-in tools.

Run `npm run check` from `agent/extensions/` for formatting, type-aware lint, type checking, and the ported tests. Tests use a temporary agent directory, leaving your config alone.

## Rendering performance

Run `npm run bench:render` from `agent/extensions/` to compare repeated redraws with explicit invalidations. It uses synthetic 160-column results (an 80-line read shown in its 10-row collapsed preview, a 40-line script, 60 search links, and 80 JSON items), so it doesn't measure the terminal or model latency. Shiki is warmed before the timings start. To collect a Node CPU profile of the benchmark worker, run `NODE_OPTIONS='--cpu-prof --cpu-prof-dir=/tmp' npm run bench:render`.

In the initial profile, rendering an unchanged nested read called `setExpanded(false)` every time, rebuilding its 80-line result (~0.6 ms); truncating all its ANSI rows again for the grouping rail added ~2.8 ms. Guarding the expansion change and clipping the single padding column brought the grouped redraw to ~0.1 ms in the original benchmark; a later run with the new preview limits measured ~0.4 ms for that grouped path and ~0.09 ms for the read preview. Completed web searches, script input, and generic highlighted output cache their lines between invalidations; partial search results still redraw the spinner. These are local benchmark figures, not a promise about whole-screen frame times.
