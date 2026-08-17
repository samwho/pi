# Talon operations and debugging

Read this when installing Talon/Community, diagnosing a command that does
nothing or the wrong thing, checking reloads, or validating a change. The
primary Community references are [installation](https://talon.wiki/Resource%20Hub/Talon%20Installation/installation_guide),
[downloading Community](https://talon.wiki/Resource%20Hub/Talon%20Installation/downloading-community),
[miscellaneous tips](https://talon.wiki/Customization/misc-tips), and
[speech troubleshooting](https://talon.wiki/Resource%20Hub/Speech%20Recognition/troubleshooting).
These are version-sensitive references; compare them with the installed Talon
build and active fileset.

## Establish the runtime first

Ask for or inspect these facts before prescribing a path or command:

- OS and Talon version/build;
- Talon Home and user-fileset paths;
- speech engine and selected microphone;
- whether the user is running Community, another fileset, or several filesets;
- focused application/window title and, for code, the active language;
- exact spoken phrase and whether the failure is recognition, matching, import,
  or the action's effect.

Typical paths are:

| Platform | Talon Home | User files |
| --- | --- | --- |
| macOS/Linux | `~/.talon` | `~/.talon/user` |
| Windows | `%APPDATA%\Talon` | `%APPDATA%\Talon\user` |

The log is normally `talon.log` in Talon Home. The installed command-line REPL
is commonly `~/.talon/bin/repl` on macOS/Linux. These are defaults, not proof;
use the Talon menu's **Scripting → Open ~/.talon**, **View Log**, and **Open
REPL** entries or ask the user for the actual locations.

## Installation and file ownership

Talon itself does not provide a useful command set until a user fileset is
loaded. For a new Community setup, Git is preferred because it permits safe
updates:

```bash
cd ~/.talon/user
git clone https://github.com/talonhub/community community
```

On Windows, use the equivalent `%APPDATA%\Talon\user` path. A zip download is
fine for exploration, but Git or a separate personal repository is safer for
long-term customization. Keep personal `.talon`, `.py`, `.talon-list`, and
snippet files in a neighboring directory rather than editing `community`.

Talon watches files and usually reloads edits automatically. If a file is not
reloading, check the log, path permissions, and symlinks in the Talon Home
path. If contributing upstream, run the Community repository's tests outside
the Talon runtime using its stubs and follow its pre-commit conventions.

## A deterministic diagnosis loop

1. **Talon process:** confirm Talon is running using the process, log, or
   menu icon when available. On Linux, a missing tray icon may only mean
   AppIndicator/KStatusNotifierItem support is absent.
2. **Microphone:** verify the OS input level, Talon's selected microphone, mute,
   gain, placement, and recording quality.
3. **Speech state:** confirm Talon is awake and in the expected mode. In
   Community (and not necessarily Dragon or other filesets), `wake up`, `go to
   sleep`, `command mode`, and `dictation mode` are the usual checks.
4. **Engine:** inspect the log for speech-engine activation. In Talon 0.4-era
   and current Community guidance, W2L Conformer/Conformer D is the normal
   command-and-dictation engine; Webspeech/Vosk are beta dictation engines and
   cannot stand alone for commands. Verify the Speech Recognition menu for the
   installed build.
5. **Fileset/load:** in Community, use `help active`, `help context`, or
   `help search ...` to see whether the command exists. Other filesets may use
   different commands; use their documentation or the REPL. Read the log for
   `[-]`, `[+]`, parse, import, and traceback lines after saving.
6. **Context:** focus the intended application/window and verify app/title/OS,
   tags, mode, and language. Use the Debug Window if available; otherwise use
   `ui.apps()` or the REPL rather than guessing an application identifier.
7. **Grammar:** use the exact rule with `sim("spoken phrase")`; inspect whether
   an optional, capture, anchor, or competing rule changes the match.
8. **Execution:** start event tracing before execution:

```python
events.tail()
mimic("a harmless phrase")
```

`mimic` tests grammar matching and action execution, not microphone capture or
ASR recognition.
9. **Action/API:** use `actions.list("prefix")` and `actions.find("term")`;
   verify the action exists, its arguments are correct, and a Context override
   is not shadowing it. Check `registry.commands`, `registry.lists`, and related
   registry data when active resources are unclear.
10. **Minimal reproduction:** temporarily reduce the command to one known-good
    action such as `app.notify(...)` or `insert(...)`, then add behavior back.

Do not say a command works just because the file parsed: prove both that it
matches in the intended context and that its side effect is correct.

## Useful REPL commands

```python
sim("tab close")                 # locate the .talon implementation
mimic("say hello world")         # execute a phrase without speaking
actions.list()                    # list all actions
actions.list("edit")             # list a prefix
actions.find("clipboard")        # search names/docs/implementations
events.tail()                     # observe actions and scope changes
settings.list()                   # inspect available settings
ui.apps()                         # inspect app/window data
```

Community's spoken command `talon open rebel` opens its REPL in many setups;
the Talon menu is the dependable fallback. The standalone `~/.talon/bin/repl`
is a REPL client that requires a running Talon instance. For a deterministic
example on Linux:

```bash
echo 'actions.speech.enable()' | ~/.talon/bin/repl
```

Use `app.notify` or a log `print` for a minimal observable test. Never paste a
secret/authentication key into a public issue or an agent transcript.

## Common failure patterns

- **Nothing happens:** Talon asleep, wrong microphone, no speech engine, empty
  user directory, or no matching command. Check those in order.
- **Wrong command:** competing spoken rules, too-broad global grammar, wrong
  mode/tag, or an exact phrase override that is not actually exact.
- **Parse error:** inspect the final log lines for file and approximate line;
  common causes are missing `)`, malformed rule syntax, wrong indentation, or
  unsupported Python-like syntax in Talonscript.
- **Import error:** the Python file imports a package unavailable in Talon's
  embedded environment, has a syntax/type/signature mistake, or runs
  context-dependent code during import.
- **Intermittent/cut-off input:** `speech.timeout` primarily affects utterance
  segmentation at pauses. Before diagnosing recordings, enable Speech
  Recognition → Save Recordings, then inspect them alongside microphone
  noise/gain; increase the timeout only as much as needed because it increases
  latency.
- **Slow or stalled behavior:** look for long action bodies, excessive
  `sleep`, blocking callbacks, and log/watchdog `(stalled)` messages. Use
  `cron` only for short periodic callbacks; put blocking polling/background
  work in a thread/process or use a non-blocking design.
- **Linux startup issue:** Talon does not support Wayland; select an X11
  session before debugging scripts.
- **Eye tracking:** calibrate after moving the tracker/monitor or changing
  lighting; inspect permissions and the Talon log before changing scripts.

For accessibility or hardware questions, prefer the wiki's hardware,
speech-recognition, and accessibility pages and clearly separate documented
facts from device-specific guesses.
