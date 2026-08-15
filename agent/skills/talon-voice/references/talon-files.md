# Talon files and grammar

Read this when editing `.talon`, `.talon-list`, hotkeys, context headers, or
phrase-level behavior. Canonical pages: [`.talon` files](https://talon.wiki/Customization/talon-files),
[`.talon-list` files](https://talon.wiki/Customization/talon_lists),
[actions](https://talon.wiki/Customization/Talon%20Framework/actions), and the
official [`.talon` overview](https://talonvoice.com/docs/).

## File layout

Talon watches the entire user directory recursively. A `.talon` file has an
optional context header followed by a body:

```talon
# Header: requirements above the one dash
os: mac
app: my_editor
-
# Body: commands, tags, settings, and hotkeys
open palette: key(cmd-shift-p)
```

The dash is significant and should appear once. With no header (or no dash),
the body starts immediately and is always active. Comments begin with `#` on
their own line. Indented action bodies use spaces; the exact indentation width
is not significant, but be consistent with the surrounding files.

A user file set is not just a collection of commands: it is the active runtime
configuration. Before editing, find the actual Talon Home/user path and all
loaded filesets. Talon Community is a common fileset, not a built-in guarantee.
Talon normally reloads changed files automatically, but a symlink anywhere in
the Talon Home path can prevent reliable change tracking.

## Context headers

Common matchers:

| Matcher | Matches |
| --- | --- |
| `os` | `linux`, `mac`, or `windows` |
| `app` | An explicitly declared well-known app |
| `app.name` | Observed application name |
| `app.exe` | Executable path/name |
| `app.bundle` | macOS bundle identifier |
| `title` | Window title |
| `tag` / `mode` | Active tags or modes |
| `code.language` | Active programming language |
| `language` | Human language, defaulting to `en` |
| `hostname` | Machine hostname |
| `user.<scope>` | A user-defined scope value |

Use a literal for an exact value or a regex such as `title: /Firefox/i`.
Regex matching is effectively Python `re.search`; flags go after the closing
slash. Inspect the runtime (`ui.apps()`, the Talon debug window, or logs) before
choosing an app/title value.

Header composition is deliberately non-obvious:

- Repeated requirements of one type are OR-ed.
- Requirements of different types are AND-ed.
- `and` joins the current requirement to the immediately preceding expression.
- `not` negates the requirement.

For example, `app: Paint`, `os: windows`, `app: Notepad` means
`(Paint OR Notepad) AND Windows`; adding `and os: windows` after the first app
instead produces `(Paint AND Windows) OR Notepad`. Keep headers simple when
possible. A more specific matching Context usually wins over a less specific
one, but do not rely on undocumented tie-breakers for competing phrases.

A file without an explicit `mode` normally applies in command mode. Use
`mode: dictation` (or another active mode) when that is intentional. Modes are
global; tags are usually better for a feature that should be enabled only in a
particular application/context.

## Voice-command rules

A command is `RULE: BODY`. The rule is a word-oriented grammar:

| Form | Meaning |
| --- | --- |
| `word` | Literal spoken word |
| `[word]` | Optional word/group |
| `foo \| bar` | Choice |
| `(foo bar)` | Grouping/precedence |
| `foo*` / `foo+` | Zero-or-more / one-or-more repetition |
| `{user.items}` | List lookup |
| `<user.capture>` | Capture |
| `^rule` / `rule$` | Start/end of an utterance block |

Rules are normally unanchored so users can chain commands in one utterance.
Anchors are appropriate for commands that should not chain, such as switching
modes or deliberately consuming the complete utterance.

List/capture occurrences bind values into Talonscript variables. Repeated uses
get `_1`, `_2`, etc.; repeated matches can be addressed with `_list`. Optional
or alternative values may be absent, so use Talonscript's null-coalescing
`or`, for example:

```talon
insert default [<user.word>]:
    insert(word or "default")
```

Do not confuse that `or` with Python boolean-or semantics. If a rule uses a
list/capture, confirm that it is declared and active in the same context.

## Talonscript bodies

Talonscript is a small statically typed language, not arbitrary Python. It
supports local assignment, strings (including multiline strings), one simple
arithmetic operation per line, action calls, `repeat(n)`, and duration-aware
`sleep(500ms)`, `sleep(2s)`, etc. A single action can use the compact form:

```talon
find on page: key(ctrl-f)
```

Use an indented body for a sequence:

```talon
search cats:
    key(/)
    sleep(100ms)
    insert("cats")
    key(enter)
```

Useful built-in actions include `key(...)`, `insert(...)`, `auto_insert(...)`,
`mouse_move(...)`, `mouse_scroll(...)`, and `mouse_click(...)`; verify names and
signatures in the installed fileset or REPL. `sleep` blocks Talon from handling
other voice commands, so use it only for a short, necessary application delay.

Hotkeys use the same body language:

```talon
key(f9): speech.toggle()
key(f10:passive): app.notify("F10 pressed")
key(f9:up): speech.disable()
```

For key syntax and held/repeated keys, see the [key action reference](https://talon.wiki/Customization/Talon%20Library%20Reference/key_action).

## Lists and `.talon-list`

A list maps spoken forms to values. In Python, declare it first with
`mod.list("name", desc="...")`, then provide the context mapping. In a
`.talon` rule, use `{user.list_name}` and refer to its value by `list_name`.

A `.talon-list` is a concise, user-editable list file. Its header identifies
the list and its body contains mappings:

```talon
list: user.key_special
-
enter
page up: pageup
```

The Python module declaration is still needed so the list has a name and
 description. Context list contents replace one another in full; they do not
merge. To extend a large upstream list without copying it, expose/use a
capture whose rule combines the base list with a user list. Community commonly
uses a more-specific `.talon-list` in a separate fileset for personal aliases.

Dynamic lists and selection lists exist in Talon 0.4 but are documented as
beta features. Use them only when the list must be generated at command time;
a static list is simpler and more predictable otherwise.

## Phrase overrides: a last resort

Two commands are only a true phrase-level replacement when their spoken rules
match exactly, including whitespace, punctuation, optionals, and captures. A
near-match loads as a second command, and Talon's tie-break behavior is not a
stable customization API. A context header does not repair a differing phrase.
Prefer, in order:

1. add a new phrase with the desired behavior;
2. override the underlying action in a narrow Context;
3. vendor/disable the original if an exact phrase replacement is unavoidable.

Keep any unavoidable override in a separate fileset and compare upstream
spoken forms after updates.
