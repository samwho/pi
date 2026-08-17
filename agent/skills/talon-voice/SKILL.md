---
name: talon-voice
description: >-
  Use this skill whenever a task involves Talon Voice or Talonscript: creating,
  modifying, or debugging .talon, .talon-list, .py, or .snippet user files;
  defining voice commands, actions, captures, lists, contexts, tags, modes,
  scopes, settings, or app integrations; voice-coding workflows; or Talon
  installation, reload, speech-recognition, and REPL troubleshooting; or
  integrating with the talonhub/community user fileset and its conventions.
  Trigger even when the user only describes a hands-free desktop or voice-coding
  problem without naming the file format.
license: MIT
compatibility: Talon Voice 0.4.x conventions; verify behavior against the installed Talon version and user file set.
metadata:
  source: https://talonvoice.com/docs/ and https://talon.wiki/
  reviewed: "2026-08"
---

# Talon Voice

Treat Talon as a runtime that loads a user's whole file set. `.talon` files
express speech grammar and context-sensitive behavior; Python files declare and
implement the actions, captures, lists, settings, and lifecycle code that the
grammar calls. The installed user file set is the source of truth for available
commands and actions.

## Start every task this way

1. Identify the Talon version, OS, speech engine, user-file-set root, and the
   application/context involved. Do not assume `~/.talon` is the right path on
   Windows (`%APPDATA%\Talon`) or that the user has Talon Community installed.
2. Inspect the existing files and conventions before editing. Search the whole
   loaded user directory, including `~/.talon/user/community` when present, for
   the action, list, tag, spoken form, or context that the user mentions; do not
   invent an action name merely because it sounds plausible. Read the relevant
   Community contract and its consuming app/language implementation first.
3. Determine ownership. Keep personal additions in a separate user fileset
   alongside `community`; avoid changing upstream/community files unless the
   user explicitly requests a fork or upstream contribution. Check git status
   before touching a Community checkout so runtime-generated files are not
   mistaken for changes to clean up.
4. Load only the reference needed for the task:
   - [Talon files and grammar](references/talon-files.md)
   - [Python framework and API](references/python-framework.md)
   - [Operations and debugging](references/debugging-and-operations.md)
   - [Voice coding](references/voice-coding.md)
   - [Sources and version notes](references/source-index.md)
   - [Community compatibility](references/community.md)

## Community compatibility gate

When Community is installed, treat the checked-out repository as the practical
source of truth for the commands and contracts Talon actually loads. Read
`community/README.md`, `PRACTICES.md`, `CONTRIBUTING.md`, the relevant
`apps/`, `tags/`, `lang/`, or `core/` files, and its `.pre-commit-config.yaml`
and `pyproject.toml` before making a non-trivial integration. Follow the
repository-specific architecture: reusable tags declare action contracts in
Python and expose grammar in `.talon`; app/language files activate only the
tags they support and implement those contracts in a narrow `Context`.

Prefer existing Community `app.*`, `edit.*`, `win.*`, `code.*`, and `user.*`
actions, tags, lists, captures, formatters, and snippets over parallel personal
names. Put personal grammar/behavior next to Community rather than editing the
checkout. For a standard Community contract, it is appropriate for a personal
Context to implement an action such as `app.tab_next`; for new personal APIs,
use a distinctive `user.` prefix. Preserve Community's object-then-verb command
style, stable app matchers (`app.bundle` on macOS, the documented Windows
forms, and `browser.host` for web apps), `.talon-list` preference, explicit tag
activation, non-no-op action contract, short non-blocking behavior, and
pre-commit/test expectations. Read [Community compatibility](references/community.md)
for the detailed checklist and validation workflow.

## Choose the right file

| Need | Prefer | Rule of thumb |
| --- | --- | --- |
| A spoken phrase, hotkey, context, tag activation, or setting | `.talon` | Keep the grammar readable and the body small. |
| Reusable behavior, an action implementation, capture parser, list declaration, or event callback | `.py` | Declare names through `Module`; implement context-specific behavior through `Context`. |
| A context-dependent mapping of spoken words to values | `.talon-list` or a Context list | Use `.talon-list` for user-editable lists; use a capture when users should extend an existing list. |
| Repeated code patterns with stops/placeholders | `.snippet`/Community snippets | Use the active editor integration when available. |

## Safe implementation workflow

1. **Inspect.** Find the relevant existing command and action. Check the exact
   spoken rule, context header, namespace, and whether another file already
   owns the name.
2. **Design.** Prefer a new, unambiguous phrase or a narrowly scoped context.
   Use an explicit well-known `app` matcher when one exists; otherwise use the
   observed `app.name`, executable basename via `app.exe`, full executable path via `app.exe_path`, `app.bundle`, or `title` value. Use a tag for
   an optional feature set, not a global pile of app-specific commands.
3. **Implement.** Put command grammar in `.talon` and Python behavior in `.py`.
   Use the smallest working example and preserve the target fileset's style.
   Custom actions, captures, lists, tags, modes, and settings belong in the
   `user.` namespace and should have a distinctive prefix to avoid collisions;
   `mod.apps` names are app matchers, not `user.*` names.
4. **Validate.** Save the files and wait for Talon's automatic reload. Read the
   Talon log for parse/import errors. In the installed Talon REPL, use the available `sim(...)`, `mimic(...)`,
   `actions.list/find(...)`, and `events.tail()` helpers to locate, replay,
   inspect, and observe behavior. If a helper is unavailable, use that build's
   documented equivalent and the log.
5. **Report.** State the files changed, the context in which the command is
   active, the runtime checks performed, and any checks that could not be run
   because Talon or the target application was unavailable.

## Non-negotiable gotchas

- A `.talon` context header is above one line containing `-`; the body is below
  it. Without a header or dash, the body has no app/OS/etc. requirements;
  unless a mode is specified, it is normally active only in command mode.
- Same-type context requirements are OR-ed; different types are AND-ed. `and`
  joins with the preceding requirement, and `not` negates. Regex matchers use
  Python-style `/pattern/flags` search semantics.
- Talon commands are normally unanchored so they can be chained. Use `^` and
  `$` only when a command must begin/end an utterance block (for example, mode
  switching).
- `@mod.action_class` method names become `user.<name>` actions. Default action
  declarations need a docstring and type annotations; use `actions.next(...)`
  deliberately when overriding an action in a Context.
- Context list contents replace one another; they do not merge. Captures are
  the extensibility pattern when users need to add entries without copying a
  large upstream list.
- Avoid near-duplicate phrase rules: precedence is not a stable customization
  API, and a near-match can load as a second command. Compare the effective
  upstream grammar, including grouping, optionals, captures, anchors, and other
  matching details. Prefer overriding the underlying action, adding a new
  phrase, or isolated vendoring and disabling the original.
- Do not block Talon's main thread with long work or unnecessary `sleep(...)`.
  Use lifecycle callbacks only for short setup and `cron` only for short
  periodic callbacks. Put blocking polling/I/O in a thread/process or use a
  non-blocking design, and marshal results back safely. Do not read
  context-dependent settings at Python import time.
- If Talon has no user files, it has no useful voice commands. If behavior is
  surprising, first establish which fileset and speech engine are actually
  loaded rather than assuming the Community commands are present.

## Minimal patterns

A context-sensitive command:

```talon
# Replace My Editor with the observed application name.
app.name: My Editor
-
hello talon: "hello world"

save safely:
    key(ctrl-s)
```

A declared Python action called from `.talon`:

```python
from talon import Module

mod = Module()

@mod.action_class
class Actions:
    def greet() -> None:
        """Insert a greeting."""
        # Use Talon actions here; keep the grammar in the .talon file.
        from talon import actions
        actions.insert("Hello!")
```

```talon
say hello: user.greet()
```

Before claiming success, prove that the file reloads and that the intended
context wins. For detailed syntax, API signatures, and diagnostic commands,
read the linked reference rather than guessing.
