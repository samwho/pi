# Talon Python framework and API

Read this when implementing `.py` files, actions, captures, lists, Context
overrides, lifecycle callbacks, or direct Talon API calls. Canonical references:
[framework overview](https://talon.wiki/Customization/Talon%20Framework/talon-framework-overview),
[Modules and Contexts](https://talon.wiki/Customization/Talon%20Framework/modules_and_contexts),
[Actions](https://talon.wiki/Customization/Talon%20Framework/actions),
[Captures](https://talon.wiki/Customization/Talon%20Framework/captures), and the
official [API reference](https://talonvoice.com/docs/).

## Modules and names

A `Module` declares names that `.talon` grammar can use. A `Context` supplies
conditions and context-dependent implementations. Python cannot define a new
spoken command directly; put the command rule in `.talon` and call the action
or capture declared in Python.

```python
from talon import Module

mod = Module()

@mod.action_class
class Actions:
    def open_project(path: str) -> None:
        """Open path in the current project tool."""
        # Implement with Talon actions or Python APIs.
        pass
```

The method above is exposed as `user.open_project`. All user-defined actions,
lists, tags, modes, and settings share the `user.` namespace. Use a distinctive
prefix rather than generic names such as `open` or `toggle`; names are shared
across every loaded fileset.

A default action class method should have a docstring and type annotations for
arguments and return value. The body can be empty when the action is intended
to be implemented only by contexts. Use `@mod.action` for a single function
when that style matches the surrounding files.

## Contexts and overrides

An empty Context is always active. Set `ctx.matches` to a Talon context-header
string to restrict it:

```python
from talon import Context, actions

ctx = Context()
ctx.matches = """
os: mac
app: my_editor
"""

@ctx.action("edit.save")
def save_in_my_editor():
    actions.key("cmd-s")
```

For several `user.` actions, use an action class:

```python
@ctx.action_class("user")
class MyEditorActions:
    def open_project(path):
        actions.key("cmd-o")
        actions.insert(path)
        actions.key("enter")

    def transform(value):
        if value == "special":
            return "custom"
        return actions.next(value)
```

A context with more matching requirements generally wins over a less specific
one. `actions.next(...)` invokes the next most-specific implementation and is
useful for a selective override; calling it blindly can recurse if the action
chain is wrong. Prefer a clear app/OS/title matcher and test the active context.

A Context can also provide:

```python
ctx.apps = ["my_editor"]
ctx.tags = ["user.my_feature"]       # replaces the whole set
ctx.settings["user.my_setting"] = 10
ctx.lists["user.my_list"] = {"spoken": "value"}
ctx.selections["user.my_selection"] = "text to select from"
```

The `apps`, `lists`, and `selections` properties are context-dependent. List
mappings do not merge across matching contexts; a more specific mapping
replaces the less-specific mapping.

## Actions, lists, and captures

Declare a list before using `{user.name}` in grammar:

```python
mod.list("project", desc="Project names")
ctx = Context()
ctx.lists["user.project"] = {
    "alpha project": "/work/alpha",
    "beta project": "/work/beta",
}
```

A capture parses speech and returns a typed value for `<user.name>`:

```python
@mod.capture(rule="(north | south | east | west)")
def direction(m) -> str:
    """One compass direction."""
    return str(m)
```

A capture may wrap a list or combine a base list with a context-specific
extension. This is generally more maintainable than forcing every user to
copy an upstream list. `@ctx.dynamic_list("user.name")` can generate a mapping
at command time; returning a string creates a selection list. Dynamic and
selection lists were beta features in Talon 0.4, so check the installed
version before depending on them.

## Settings, tags, modes, scopes, and apps

Declare public configuration with a type, default, and description:

```python
from talon import Module, settings, actions

mod = Module()
mod.setting(
    "project_wait_ms",
    type=int,
    default=100,
    desc="Delay before the project window receives pasted text",
)

@mod.action_class
class Actions:
    def paste_to_project() -> None:
        """Paste after the configured project delay."""
        actions.sleep(f"{settings.get('user.project_wait_ms')}ms")
        actions.edit.paste()
```

Settings are undefined during startup. Read them from an action or a
registered lifecycle callback, not while the module is importing. In a
`.talon` file, values are set in `settings():`; a matching, more-specific
context can change them.

Use `mod.tag("feature", desc="...")` for an optional command family, then
activate it with `tag(): user.feature` in a `.talon` file or with
`ctx.tags = ["user.feature"]`. Modes are global and useful when normal
commands should be disabled; tags are usually better for scoped features.
Use `@mod.scope` only when a string-valued matcher is needed and the script can
keep it updated. Use `mod.apps.<name>` for reusable app matchers:

```python
mod.apps.my_editor = """
os: mac
and app.bundle: com.example.editor
"""
```

A separate file can add another matcher to the well-known app, and a `.talon`
header can then say `app: my_editor`.

## Runtime APIs and lifecycle

The official stable surface includes:

- `talon.actions`, `talon.registry`, `talon.scope`, `talon.settings`, and
  `talon.storage` for runtime integration/introspection;
- `talon.app.register("ready"|"launch"|"startup", callback)`,
  `app.unregister(...)`, and `app.notify(...)`;
- `talon.clip.text/set_text/image/set_image/clear`, plus `clip.capture()` and
  `clip.revert()` context managers;
- `talon.fs.watch(path, callback)` and `fs.unwatch(...)`;
- `talon.noise.register("pop"|"hiss"|"", callback)` and `unregister(...)`.

Other commonly used modules include `ui`, `cron`, `screen`, `imgui`, `canvas`,
`ctrl`, and `skia`; their signatures are version-sensitive. Talon ships
`.pyi` stubs inside its resources Python site-packages directory. Prefer those
stubs and the installed user fileset over guessing an API. Talon embeds Python,
so the host Python installation is not the API environment. Use a Talon
`.venv` only when a package is genuinely required and the target user accepts
that setup cost.

Keep callbacks short and non-blocking. Use `cron` for periodic work and avoid
network calls or long loops on Talon's main thread. When doing file or process
integration, clean up watchers, timers, and event registrations on reload when
the surrounding codebase provides a pattern for doing so.
