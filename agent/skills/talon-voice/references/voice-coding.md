# Voice coding with Talon Community

Read this when a task concerns programming-language support, code formatting,
snippets, operators, symbols, editor integrations, or designing a command for
code. Canonical pages: [voice-coding overview](https://talon.wiki/Voice%20Coding/voice-coding-overview),
[formatters](https://talon.wiki/Voice%20Coding/formatters),
[operators](https://talon.wiki/Voice%20Coding/operators),
[symbols](https://talon.wiki/Voice%20Coding/symbols),
[snippets](https://talon.wiki/Voice%20Coding/snippets), and
[language-specific commands](https://talon.wiki/Voice%20Coding/language-specific).
These are Community conventions; another user fileset may use different
phrases and actions.

## Select the active language

Community can infer a language from the active file's extension/title in
supported applications, or force one globally:

- `force {user.language_mode}` activates a language mode;
- `clear language mode` returns to title tracking in current Community;
- `help operators`, `help symbols`, `help keywords`, and `help snip` show what
  is active;
- `help active` and `help context {user.help_contexts}` reveal the loaded
  command set.

The installed fileset is authoritative: the Wiki currently documents the
plural `clear language modes`, while current Community uses the singular form,
and these commands are version-dependent.

For a new editor integration, make sure the filename (including extension) is
in the window title and implement the app-specific `win.filename` action,
normally in `@ctx.action_class("win")`. Inspect the existing VS Code
implementation rather than inventing a new language detector.

## Formatting and code tokens

Formatters turn dictated words into identifiers or literal code:

| Spoken formatter | Output shape for `one two three` |
| --- | --- |
| `camel` | `oneTwoThree` |
| `snake` | `one_two_three` |
| `kebab` | `one-two-three` |
| `constant` | `ONE_TWO_THREE` |
| `hammer` | `OneTwoThree` |
| `smash` | `onetwothree` |
| `dunder` | `one__two__three` |
| `dotted` | `one.two.three` |
| `packed` | `one::two::three` |
| `string` / `dub string` | `'one two three'` / `"one two three"` |
| `conga` / `slasher` | `one/two/three` / `/one/two/three` |

Use the active list-based operator grammar rather than hardcoding punctuation:

```talon
op {user.code_operators_math}
is {user.code_operators_math_comparison}
(bit | bitwise) {user.code_operators_bitwise}
```

Use `help operators` to see the lists and grammar supported by the active
version.
Use `pad <user.symbol_key>` for spaced symbols and paired-delimiter commands
such as `round`, `box`, `curly`, `twin`, and `quad` where Community provides
them. Prefer a language's existing operator/symbol lists instead of hardcoding
punctuation into every new command.

## Snippets

Snippets insert a formulaic block with placeholders. `snip {user.snippet}`
inserts a named snippet and `snip next` moves to its next stop. Use `help snip`
to inspect the active set. With the VS Code `command-server` extension, VS Code
can own snippet placeholder movement; Cursorless is required for wrapping code
in snippets. Without editor support, `snip next` assumes the cursor remains on
the same line, and raw insertion may need these settings:

```talon
app: vscode
-
settings():
    user.snippet_raw_text_paste = true
    user.snippet_raw_text_spaces_per_tab = -1
```

Community actions useful from custom commands include:

```talon
static cast: user.insert_snippet("static_cast<$1>($0)")
return named: user.insert_snippet_by_name("returnStatement")
```

Use the exact action signature in the installed Community version.
`user.insert_snippet_by_name` accepts an optional substitution mapping; do not
assume all editors support the same stop behavior.

## Community's language architecture

The `lang` directory separates language-specific implementation from shared
commands:

- `<language>/<language>.talon` is required and activates supported `user.code_*`
  tags and unique language commands;
- add `<language>/<language>.py` when language-specific actions, lists, captures,
  or settings are required;
- `lang/tags/*.talon` contains shared command grammars;
- `lang/tags/*.py` declares shared contracts, some of which have defaults.

Common tags include `user.code_functions`, `user.code_functions_common`,
`user.code_keywords`, `user.code_data_bool`, `user.code_data_null`, and
`user.code_object_oriented`. To add a language, follow a mature neighboring
implementation: register its extension in the language-mode mapping, create
the language `.talon` file, activate only supported tags, and implement only
the contracts it uses (in `.py` when declarations are needed). Do not activate
a generic tag without implementing its contract.

A shared command should depend on a tag contract rather than knowing the
language. For example:

```talon
tag: user.code_functions
-
strut <user.code_type>: '{code_type} '
```

The active language supplies the `code_type` capture/action behavior.

## Designing maintainable coding commands

- Prefer existing Community actions, tags, formatters, lists, and snippets;
  search the user set before adding a duplicate.
- Keep grammar composable and normally unanchored so users can chain commands.
- Put aliases in lists or `.talon-list` files so users can customize words
  without editing Python.
- Restrict editor-specific commands by a reliable app/title matcher and keep
  generic language commands behind a tag.
- Test with the real editor: reload, inspect `help active`, force/clear the
  language mode as needed, run a small command, and verify resulting text and
  cursor/snippet position.
- Cursorless, Rango, gaze-OCR, command-server, and Talon-HUD are optional
  integrations. Detect whether one is installed before depending on its
  actions or commands.
