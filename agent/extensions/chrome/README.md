# Chrome

Compact tool rendering through Pi's public `registerToolRenderer` API. Execution,
schemas, prompts, and model-facing results are unchanged. A scoped layout adapter
handles consecutive tool groups; it is removed on shutdown or reload.

## Layout

`renderTool` in `render.ts` renders both normal calls and nested codemode calls.
Padding surrounds each consecutive run of visible tool calls, not individual
calls. Adjacent top-level tools and nested lists have no internal padding. Visible
prose, thinking, or other transcript content ends a run; invisible messages do not.
Calls have a neutral background, a status marker, and a tool heading.
Nested calls form a compact indented list below `codemode`, without frames or
source-code boxes. Codemode shows a spinner during writing/execution. Edit
additions are green and removals are red. Grep regexes use Shiki's regexp grammar
(literal searches stay plain); missing read targets have red paths. Existence
checks run asynchronously, cache for one second, and treat only ENOENT/ENOTDIR
as missing. Read ranges follow the path after a middot and are blue. These
decorations apply to normal and nested calls.

While write/edit/codemode calls are in progress, their heading shows a live
`~N tokens` counter for streamed content, old + new edit text, or script source.
It uses Pi's `estimateTokens` (text characters / 4, rounded up), not a tokenizer.
The counter holds during execution and is replaced by the normal result summary.

Completed reads and greps show estimated returned-content tokens, including Pi's
fixed image allowance. Grep also shows matching-row counts (not regex occurrences
within a row), excluding context rows. Zero is shown explicitly. Truncated counts
use `N+ matches` rather than implying a complete total. Lightweight display stats
for nested reads/greps/Bash/codemode are saved as hidden `chrome-tool-stats/v1` session entries,
so future reloads preserve them without retaining raw results. Older calls without
saved results/stats show `? matches` / `~? tokens`, never a fabricated zero. Counts use returned content after middleware and
truncation, not the full source file. For nested calls this estimates returned data;
only the script's chosen output is actually added to the model's context.

Thinking summaries form one paragraph separated by `·`, wrapping naturally
at the terminal width. This display-only transformation leaves their stored text
unchanged and does not change normal assistant Markdown.

Successful output stays hidden. Click or use the tool expansion shortcut (normally
Ctrl+O) for arguments, diffs, and output. Failures show a short excerpt. Pi handles
images. The original custom bottom bar lives in `session-footer.ts`; the built-in
header and working indicator are left alone.

Live nested results are captured only from finalized `tool_execution_end` events,
after result middleware such as secret redaction. Bounded, session-local storage
keeps up to 16 parents and 256 children per parent. Pi does not persist child
results: restored calls use the session's structured `nestedCalls.arguments`
records for full paths and ranges, rather than trying to parse codemode's shortened
argument previews. Preview metadata supplies status/order and is a fallback for
older sessions. If Pi omitted arguments because of its recording limits, the row
explicitly says `[arguments unavailable]`. Old result-dependent summaries, such as
edit deltas, still cannot always be recovered. New read/grep counts survive reload
through the display stats entries; old absent counts remain explicitly unknown.

## Bash

- `shfmt` 3.14.1 (pinned in the repository's `mise.toml`) parses and formats Bash.
  Chained commands/pipelines get AST-selected continuation breaks before formatting.
- Shiki's Bash TextMate grammar with GitHub dark/light palettes highlights flags,
  strings, variables, operators, and other syntax.
- Literal command positions come from shfmt's AST. Built-ins, script functions,
  and executable files found on PATH or in the local working directory are green;
  unresolved literal commands are red.
- Commands appear in full beneath the tool heading. Long lines wrap, never truncate.
- Bash headings show the configured timeout, live elapsed execution time, and
  estimated output tokens once output is available. Codemode also shows live
  elapsed time and output tokens, keeping its running input-token estimate distinct.
  Final durations use Pi's recorded execution time and remain visible after
  completion, including restored nested calls with duration metadata. Output-token
  estimates include returned text/images, not hidden reasoning or billed usage.
- Formatting/highlighting run asynchronously and are cached. Incomplete input or
  formatter failure keeps the original source visible. Source is never evaluated.

Command lookup checks the local directory as well as PATH, including relative
binary paths. Literal `cd` in straight-line statements and successful `&&` chains
updates the lookup directory; subshell, function, and pipeline changes stay scoped.
This is a display hint, not Bash command-resolution validation: bare local names
are accepted even if `.` is not on PATH. Dynamic directories, PATH assignments,
aliases, startup functions, and dynamically computed command names are not simulated. Source and execution arguments remain unchanged. The formatter binary is
resolved in mise's data directory at its pinned version, so it also works before a
running Pi process receives a refreshed PATH. Update `shell.ts` if changing that pin.

File paths in headings are shortened in the middle, retaining the beginning and
filename while reserving room for ranges, deltas, and counters. Oversized search
patterns are also shortened, so neither pattern nor path can push trailing stats
off the row. Expanded arguments
retain the full path. Other oversized heading content is clipped; expanded output wraps. There is no
vertical preview limit in expanded output. The old `agent/visuals/config.json`
is unused.

Restart Pi once after replacing `visuals/`, whose old patches survive `/reload`.
Subsequent Chrome-only changes can use `/reload`.

## Per-tool customisations

`formatters/index.ts` is the single enable/disable list. Put each customisation in
its own module under `formatters/`, then import it and add it to that list. Remove
it from the list to restore the generic display. Tool names match exactly, with
hyphens and underscores normalised for native/identifier-safe MCP spellings.

A module exports a `ToolFormatter` (`formatters/types.ts`):

- `tools`: the tool names it handles.
- `call(args)`: optional plain-text `{ label, subject }` for the heading.
- `result(result)`: optional plain-text `{ summary }` for successful results.
- `unavailableSummary`: optional placeholder for historical calls without results.

Callbacks are pure display transformations, not tool overrides. Return `undefined`
for unsupported shapes; thrown callbacks also fall back to generic rendering.
The shared renderer keeps status/spinners, indentation, background, truncation,
reserved summary space, errors, images, and expansion. Both direct and nested calls
use this path. Short sanitised result summaries (up to 256 characters) are saved
with the existing hidden stats metadata, so future nested calls survive reload.

The first module, `slack-search.ts`, handles public and public/private message
searches. It displays keywords plus filters (or the older query/semantic query
fields), then the number of returned results, including zero:

```text
✓ slack search pi · 3 results
```

It accepts structured responses and JSON/Markdown text responses. Category counts
are combined without counting the repeated summary twice, and page results are
not confused with a larger total. Older calls lacking a saved count show
`? results` rather than an invented zero.

## Transcript layout integration

Pi's public tool-renderer API cannot group neighboring transcript components, and
its self-render shell adds a spacer per tool. `tool-layout.ts` uses a small
`InteractiveMode.getRegisteredToolDefinition` bridge to reach the chat container.
Only that container's render/mouse methods are adapted. Original transcript
children, execution, and expansion state remain untouched. Grouped rows translate
mouse coordinates back to their original components. Both the bridge and container
methods are restored on shutdown/reload; there are no persistent renderer patches.
This adapter depends on Pi's internal chat-container and call-component fields.

No new tests yet. `chrome/vitest.config.ts` supplies host-package resolution only
for the existing read-agents and shared tests.
