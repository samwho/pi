# Scrolling performance

Run a real fullscreen Pi session in an isolated tmux server, load the normal
plugins, and send scroll input at 120 events/second. The default history is
synthetic: 120 turns, 601 entries, native read/bash, MCP snapshots, evaluated
functions, console messages and page lists, codemode scripts and nested-call
metadata, Markdown, thinking, Unicode, and errors. Long lines in both native
results and script output exercise horizontal truncation. No model requests or
tools are executed. Expanded output has a separate render budget because it lays
out the complete results, not just their previews.

```sh
mise install
cd ~/.pi/agent/extensions
npm run test:scroll
npm run profile:scroll
```

Pi, Node, and tmux must be installed. The runner also finds a mise-installed tmux
when it isn't on `PATH`. Run performance tests **serially on an otherwise quiet
machine**, not alongside unit tests or other benchmarks.

## What gets checked

The default budgets are:

- p95 render duration <= 8 ms for collapsed output, leaving headroom within Pi's
  16 ms render interval; expanded output gets a full 16 ms frame budget;
- no individual render > 50 ms;
- p95 sent-input-to-completed-frame latency <= 50 ms;
- at least 50 changed viewport frames/second at sustained scrolling rates;
- every sent event received and represented in a completed frame.

Pi coalesces input: several wheel events can reach one frame. There isn't a
requirement to paint a frame for every input. A persistent tmux control client
sends raw SGR wheel sequences, not tmux copy-mode commands. The test fails if the
input driver can't sustain its requested rate, or the viewport doesn't move.

Timing runs don't enable the profiler. `profile:scroll` additionally uses Node's
V8 CPU profiler through `node:inspector/promises`, sampling every 1 ms. Startup,
initial highlighting/formatting, and expansion warmup happen before measurement.
The probe patches only the disposable process, checks the internal methods it
uses, and restores them on shutdown. It isn't loaded during ordinary Pi startup.

Budgets are machine-dependent and can be overridden explicitly:

```sh
npm run test:scroll -- --render-budget 12 --latency-budget 60
```

The deterministic cache/invalidation tests in `npm test` complement these timing
checks. They verify that completed renders don't redo layout, session statistics
don't rescan unchanged history, and deferred highlighting and formatting remain
visible. They run without tmux.

## Other workloads

```sh
# Expanded output and PageUp/PageDown across conversation history.
npm run test:scroll -- --expanded --pages

# Send input without rate limiting; Pi should coalesce it without losing events.
npm run test:scroll -- --hz 0

# A larger stress workload and a narrower terminal.
npm run profile:scroll -- --turns 250 --width 100 --no-check

# Replay a COPY of a private conversation, leaving the original untouched.
npm run profile:scroll -- --session /absolute/path/to/session.jsonl

# Control run without the normal extensions (the explicit probe still loads).
npm run profile:scroll -- --bare
```

Page tests alternate direction every 30 events. Wheel tests travel upwards.
`--events` changes the number of events (default 600, minimum 120). `--hz 0`
saturates the input path. `--turns`, `--width`, and `--height` control the fixture
and terminal geometry. `--agent-dir` allows comparison against a separate Pi
configuration without changing the live setup.

## Artifacts

The runner prints its temporary output directory. `--out /fresh/directory`
chooses one explicitly. Existing runs are never overwritten.

- `summary.json`: versions, workload, percentiles, throughput, and failures;
- `metrics.json`: input receipt timestamps, frame timings, and viewport positions;
- `sent.json`: driver timestamps, used for input-to-frame latency;
- `scroll.cpuprofile`: CPU profile, when profiling is enabled;
- `screen.txt`: final tmux screen;
- `session.jsonl`: the synthetic history or private replay copy.

Open the CPU profile in VS Code's JavaScript CPU-profile viewer, or summarise it:

```sh
node visuals/perf/profile-summary.mjs /path/to/scroll.cpuprofile
```

`--no-check` reports budget violations without returning a failing exit status;
use it for diagnosis, not regression gates. Setup errors still fail.

Artifacts from a private replay contain conversation history. Keep them local;
don't commit or upload them. The runner uses `--offline`, does not submit prompts,
and kills only its own isolated tmux server. Extensions still have their normal
startup behaviour, which can include network activity.

## Findings, 30 September 2026

Node v26.10.0, Pi 0.99.1, tmux 3.7c, 160x50, normal plugins. A recent 1,580-entry
conversation was copied and replayed with 600 wheel events at 120 Hz. Before and
after runs were serial, with the same driver and geometry:

| Metric                       | Original renderers | Cached renderers |
| ---------------------------- | -----------------: | ---------------: |
| p50 render                   |           11.71 ms |          2.50 ms |
| p95 render                   |           13.80 ms |          3.30 ms |
| p95 input to completed frame |           28.08 ms |         18.74 ms |
| Changed frames/second        |              63.95 |            64.10 |
| Inputs received/rendered     |            600/600 |          600/600 |

The original renderers fail the 8 ms render budget. Pi already coalesced scrolling
near its render limit; the improvement is CPU headroom and latency, not a higher
configured frame rate.

The initial profile attributed roughly two-thirds of rendering CPU time to
codemode results rebuilding frames, wrapping output, adding grouping rails, and
clipping ANSI lines on every redraw, including offscreen results. Completed
results now cache their rows. Native child invalidation also refreshes the parent,
so deferred highlighting doesn't get stuck behind the cache. Partial results stay
live; expansion and theme/width changes still rebuild the view.

The footer also rebuilt the session projection and rescanned costs on every
scroll frame. These statistics now cache against the session leaf and model, with
explicit invalidation at model/turn changes. Git, thinking level, and status
information are still read live.

The larger fixture exposed a separate startup redraw loop: more than 32 restored
scripts could evict their pending formatting promises from the shared LRU and
reformat each other indefinitely. Each tool now retains its formatting promise in
its renderer state. A 40-script regression test covers this case. Result-preview
wrappers also reuse their clipped rows while the child rows are unchanged.

### Limits

This measures Pi completing a render and writing it to a tmux PTY. It does **not**
measure the final terminal emulator's painting or display latency. Regular-mode
scrollback is owned by the terminal and isn't covered.

The remaining profile cost is mostly native PTY writes and Pi's full-transcript
container/layout work. Very large expanded histories can still exceed the budget:
expanded PageUp/PageDown measured 14.73 ms p95 in a 120-turn timing run; a
250-turn stress run ranged from roughly 6–18 ms p95 across local runs. That
workload is intentionally available rather than hidden by truncating history or
removing functionality. Further improvements would need upstream transcript
layout/virtualisation work, with care for selection, search, and prompt navigation.
