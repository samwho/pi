# Talon Community tag reference

Use this reference when integrating an application with the installed
`talonhub/community` fileset. It inventories the capability and state tags in
the local Community checkout reviewed in September 2026. Community evolves, so
search the loaded checkout before relying on this list.

## How to use tags

A tag is a contract, not merely a bundle of convenient phrases. Before adding
app-specific commands:

1. Search global grammar first. Core commands such as `go top`, `go bottom`,
   `scroll up`, and `scroll down` are always available and call standard
   actions; often the right integration is a narrow action override rather than
   a new phrase or tag.
2. Search Community for an applicable capability tag and read both its `.talon`
   grammar and Python action declarations.
3. Activate every capability the application genuinely supports with
   `tag(): user.name` (or the built-in `browser`, `terminal`, or `debugger`).
4. Implement every action contract used by that grammar in a narrow `Context`.
   Do not activate a tag when inherited actions would be wrong or important
   operations would be no-ops.
5. Do not activate shell, terminal, file-manager, editor, or document-reader
   tags merely because an app contains text, files, pages, or runs in a
   terminal. Match the UI's semantics.
6. Prefer the shared vocabulary over app-specific duplicate phrases. Add a
   short alias only when the user explicitly wants one and it does not create
   an ambiguous near-duplicate.

Tags in the `user.` namespace are Community/user tags. `browser`, `terminal`,
and `debugger` are Talon-level tags used by Community.

## General application capabilities

| Tag | Activate when |
| --- | --- |
| `browser` | The focused app/context is a web browser and implements Community browser actions. |
| `terminal` | A real shell terminal prompt is active. Do not use for a TUI such as Pi. |
| `debugger` | A debugger interface is active and debugger action contracts are implemented. |
| `user.address` | The UI can navigate to an address or path, such as a browser address bar or Finder's Go to Folder. |
| `user.chapters` | A reader can move between chapters. |
| `user.command_client` | An editor implements Community's file-based Talon command/RPC client. |
| `user.command_search` | The app has a command palette or equivalent arbitrary-command search. |
| `user.debugger` | Enable Community's generic debugger command grammar for a supported debugger. |
| `user.emoji` | Text entry supports the Community emoji/emoticon/kaomoji vocabulary. |
| `user.file_manager` | The current UI browses files/directories and implements the file-manager action contract. |
| `user.find` | The UI supports find, next match, and previous match through `edit.find*`. |
| `user.find_and_replace` | The UI supports the richer find/select/replace action contract. |
| `user.line_commands` | A text editor exposes meaningful numbered-line navigation and selection. |
| `user.messaging` | A multi-channel messaging app supports channel, server, and message navigation. |
| `user.multiple_cursors` | A text editor supports creating and controlling multiple cursors. |
| `user.navigation` | A browser-like hierarchy supports back, forward, refresh, and related navigation actions. |
| `user.pages` | A document reader has discrete pages and implements next/previous/jump/final/rotation. This tag also activates `user.navigation`. |
| `user.splits` | The app supports creating, focusing, resizing, and closing split regions. |
| `user.tabs` | The app or surrounding container implements Community's tab action contract. |

## Terminal and command-line capabilities

| Tag | Activate when |
| --- | --- |
| `user.readline` | The focused text input uses Emacs/readline editing semantics. It overrides standard edit actions such as word and line movement. |
| `user.readline_vi` | Readline is specifically in vi editing mode. |
| `user.generic_unix_shell` | A Unix shell prompt is active; enables generic shell command construction. |
| `user.generic_windows_shell` | A Windows shell prompt is active. |
| `user.unix_utilities` | A Unix shell supports Community's commands for tools such as `cat`, `grep`, and `tail`. |
| `user.git` | A shell prompt supports Git command grammar. |
| `user.anaconda` | A shell prompt supports Conda/Anaconda commands. |
| `user.kubectl` | A shell prompt is intended to receive Kubernetes `kubectl` commands. |
| `user.terraform_client` | A shell prompt is intended to receive Terraform commands. |
| `user.taskwarrior` | A shell prompt is intended to receive Taskwarrior commands. |
| `user.tmux` | The focused terminal is inside tmux and its command mappings are implemented. |
| `user.wsl` | The active shell environment is Windows Subsystem for Linux. |
| `user.i3wm` | The i3 window manager command context is active. |
| `user.gdb` | GDB-specific debugger commands should be active. |
| `user.windbg` | WinDbg-specific debugger commands should be active. |

## Programming-language capability tags

Activate these from a concrete language context only when that language
implementation supplies the corresponding actions and syntax.

| Tag | Capability |
| --- | --- |
| `user.code_comment_block` | Generic block-comment commands. |
| `user.code_comment_block_c_like` | Marks C-style `/* ... */` block-comment syntax. |
| `user.code_comment_documentation` | Documentation-comment commands. |
| `user.code_comment_line` | Line-comment commands. |
| `user.code_concurrent` | Concurrency-oriented language constructs. |
| `user.code_data_bool` | Boolean literals and checks. |
| `user.code_data_null` | Null/nil literals and checks. |
| `user.code_functional` | Functional-language constructs. |
| `user.code_functions` | Function declaration and invocation syntax. |
| `user.code_functions_common` | Common standard-library function vocabulary. |
| `user.code_imperative` | Imperative control-flow constructs. |
| `user.code_keywords` | Language keyword vocabulary. |
| `user.code_libraries` | Import/include/library syntax. |
| `user.code_object_oriented` | Class, object, method, and inheritance syntax. |
| `user.code_operators_array` | Array/indexing operators. |
| `user.code_operators_assignment` | Assignment operators. |
| `user.code_operators_bitwise` | Bitwise operators. |
| `user.code_operators_lambda` | Lambda/anonymous-function syntax. |
| `user.code_operators_math` | Arithmetic and comparison operators. |
| `user.code_operators_pointer` | Pointer/reference operators. |
| `user.stylua` | StyLua commands in a Lua context. |
| `user.talon_python` | Talon-flavoured Python/Talon REPL support. |
| `user.talon_populate_lists` | Populate Talon-specific action/scope/mode lists while editing Talon code. |

## Modes, optional behavior, and platform state

| Tag | Activate when |
| --- | --- |
| `user.code_language_forced` | A user explicitly forced a programming language instead of title-based detection. Usually managed by Community. |
| `user.deep_sleep` | Deep-sleep mode is active and the longer wake phrase is required. |
| `user.experimental_window_layout` | The user opted into Community's experimental window-layout commands. |
| `user.gamepad` | Gamepad bindings should be active. |
| `user.mouse_cursor_commands_enable` | Optional voice commands for showing/hiding the mouse cursor are enabled. |
| `user.pop_twice_to_repeat` | Two pop sounds should repeat the last command. |
| `user.pop_twice_to_wake` | Two pop sounds should wake Talon from sleep. |
| `user.screenshot_disabled` | Screenshot commands must be disabled in the current context. |
| `user.unprefixed_numbers` | Bare spoken numbers are allowed without Community's normal number prefix. |

## Transient UI/state tags

These are normally managed by the component that owns the UI. Do not activate
them as general app capabilities.

| Tag | Active while |
| --- | --- |
| `user.are_you_sure` | Community's confirmation UI is visible. |
| `user.breaking_changes_notice_showing` | The breaking-changes notice is visible. |
| `user.code_functions_common_gui_active` | The common-function picker is visible. |
| `user.continuous_scrolling` | Continuous mouse scrolling is running. |
| `user.draft_editor_active` | The draft editor is active. |
| `user.draft_editor_app_focused` | The draft editor application is focused. |
| `user.draft_editor_app_running` | The draft editor application is running. |
| `user.draft_window_showing` | Talon's draft window is visible. |
| `user.gamepad_tester` | The gamepad tester UI is visible. |
| `user.help_open` | Community help is open. |
| `user.help_scope_open` | The scope-inspection help UI is open. |
| `user.homophones_open` | The homophones UI is open. |
| `user.microphone_selection_open` | The microphone picker is open. |
| `user.mouse_grid_showing` | The mouse grid is visible. |
| `user.new_user_message_showing` | Community's new-user notice is visible. |

## Verification commands

Search the installed checkout rather than trusting this snapshot blindly:

```bash
rg 'mod\.tag\(' ~/.talon/user/community -g '*.py'
rg '^\s*tag:' ~/.talon/user/community -g '*.talon' -g '*.py'
rg '^\s*tag\(\):' ~/.talon/user/community -g '*.talon'
```

For a candidate tag, read its grammar and action declaration before activating
it, then search existing app integrations for correct implementations.
