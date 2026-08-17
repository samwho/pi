# Talon Community compatibility

Read this when a task touches the checked-out `talonhub/community` fileset or
needs to interoperate with its commands, actions, tags, lists, language modes,
or app integrations. The local checkout is the practical source of truth for
the version actually loaded by Talon; the upstream repository and wiki may be
newer or use different conventions. This guidance was checked against the
local checkout at commit `e71eaa30` on 2026-08-15; recheck it after Community
updates.

In this environment the checkout is normally:

```text
~/.talon/user/community
```

Resolve the actual Talon Home/user root first. Do not assume Community is
installed, and do not edit the `community` checkout for a personal
customization unless the user explicitly asks for an upstream-style change.
Keep personal files in a neighboring user-fileset directory. This preserves
clean git updates and lets a more-specific personal Context or list override
Community without merge conflicts.

## Read the repository before extending it

For a non-trivial integration, inspect the relevant local files plus:

- `README.md` for the public command set and which tags applications activate;
- `PRACTICES.md` and `CONTRIBUTING.md` for current design/contribution rules;
- `.pre-commit-config.yaml` and `pyproject.toml` for formatting, lint, and test
  expectations;
- `core/`, `apps/`, `lang/`, `tags/`, `plugin/`, and `test/` for the relevant
  existing pattern.

Search the whole loaded user directory, not only Community: another fileset
may already declare the action, phrase, list, tag, setting, or app matcher.
Check `git status` before and after inspecting the checkout; Community may have
runtime-generated untracked files such as settings, stored state, or personal
lists that must not be changed or cleaned up.

## Community architecture

Use the existing Community contracts instead of inventing parallel commands:

- `core/` contains shared primitives and global commands.
- `apps/<app>/` contains app matchers, app-specific `.talon` grammar, and
  Context implementations. App `.talon` files commonly activate reusable
  tags, for example `user.tabs`, `user.splits`, `user.find_and_replace`, or
  `terminal`.
- `tags/<feature>/` contains reusable grammar in `<feature>.talon` and, when
  needed, `<feature>.py` declaring the tag and empty action contracts. The tag
  file calls `user.<action>` actions; each consuming app/context implements the
  contract in Python.
- `lang/tags/` contains shared language grammar/contracts. A language's
  `lang/<language>/<language>.talon` activates only the supported `user.code_*`
  tags, and its Python file implements the corresponding contracts.
- `plugin/` contains optional features that are normally activated explicitly.
- `test/` contains host-Python tests using Talon stubs; these do not run inside
  Talon's embedded runtime.

Do not activate a reusable tag without implementing the action contract it
requires. Conversely, do not add an unused action abstraction merely because
it might be useful later. If a personal feature intentionally consumes a
Community contract, a small neighboring personal `.talon` file that activates
the tag plus a narrow personal `Context` implementation is usually the
cleanest integration.

## Matchers and naming

Follow the repository's platform-specific matcher conventions:

- macOS apps: prefer `app.bundle` (usually through `mod.apps.<name>`);
- Windows apps: use the repository's OR-ed `app.name` and `app.exe` forms;
- web apps: prefer an exact `browser.host`, anchoring regexes when matching
  subdomains;
- otherwise use an observed `app.name`, `app.exe`, `app.exe_path`, `title`, or
  a deliberately maintained user scope.

All shared user declarations live in the `user.` namespace. Use a distinctive
prefix for new personal actions, lists, settings, captures, scopes, and tags
unless deliberately implementing a standard Community contract such as
`app.tab_next` or `user.split_window_right`. Do not claim that a `mod.apps`
name is a `user.*` action or scope; app matcher names and user declarations are
different namespaces.

For new spoken commands, Community prefers object-then-verb grouping (for
example `file save`), cautious use of short global phrases, composable and
normally unanchored rules, and lists/captures instead of a large collection of
near-duplicate rules. Search the effective upstream grammar before adding a
phrase. A near-match is a second command, not a reliable override. Prefer an
action Context override or a new unambiguous phrase; only vendor/disable an
exact upstream grammar when that is genuinely necessary.

## Actions, tags, lists, and state

- Put grammar in `.talon` and reusable behavior/contracts in `.py`.
- Declare default actions with docstrings and annotations; implement them in
  `@ctx.action_class(...)` for the consuming app/context.
- For a selective Context override, use `actions.next(...)` intentionally to
  preserve the less-specific behavior; do not call it blindly or recurse.
- If a matching context has no reasonable implementation for an action, do not
  silently provide a no-op. Community's P09 convention is to raise an
  exception for an inappropriate active implementation; if no implementation
  exists, omit the override so Talon reports the missing action. This prevents
  a command from continuing after an operation that did not happen.
- Prefer `.talon-list` for user-editable lists. A context list replaces the
  mapping rather than merging it; a more-specific personal list can override
  Community without editing the upstream list.
- Use Community's stored-state actions for persistent state so files remain in
  its `stored_state/` area and respect its git-ignore conventions.
- Use tags for optional, context-scoped command families and modes for global
  state changes. A tag's `.talon` grammar should be inactive until a consuming
  context activates it.

## Runtime and validation

Talon loads the entire user directory, including Community and personal files,
and usually reloads changed files automatically. Validate both integration and
effect:

1. inspect the exact Community rule/action/tag and the active context;
2. save and read the Talon log for reload, parse, import, and traceback errors;
3. use Community's `help active`, `help context`, and `help search` when
   available;
4. use the installed REPL's `sim(...)`, `mimic(...)`, `actions.find(...)`,
   `events.tail()`, `scope`, and registry helpers as appropriate;
5. run host-Python tests with the repository's stubs when adding testable
   logic, and use the installed Talon/venv only for runtime-specific checks;
6. run focused formatting/lint checks before claiming a repository-compatible
   change.

`mimic(...)` executes a command and can change the target app, so use a harmless
phrase or a disposable context when testing. A successful Python compile or
Talon reload proves syntax/importability, not that the right Community grammar
wins or that the action has the intended side effect.

## Formatting and repository checks

The current Community checkout uses pre-commit hooks including:

- `talon-fmt` for `.talon` grammar;
- `snippet-fmt` for snippets;
- Ruff lint/fix and Ruff format for Python;
- general whitespace, newline, symlink, conflict, and private-key checks;
- Oxfmt for supported Markdown/YAML/TOML/JSON files.

Its Python target is `py310`, while Talon 0.4 action signatures still need
compatibility with the embedded runtime (for example, avoid modern union
syntax in action declarations where the local Community code avoids it).
Run the repository's tests outside Talon with its stubs; do not install or
mock Talon's runtime APIs into a normal personal package just to satisfy an
editor.

Community also favors small, focused changes, no dead/commented-out code,
short non-blocking actions, `actions.sleep` rather than `time.sleep`, and only
brief sleeps (roughly 200 ms total or less) when an application genuinely
needs a delay. For an upstream contribution, check its current branch,
pre-commit configuration, tests, and contribution guidance separately; a
personal integration should normally remain outside the checkout.
