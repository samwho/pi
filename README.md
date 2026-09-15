# Pi configuration

Personal configuration for [Pi](https://pi.dev/). Pi runs directly on the host;
there is no VM or sandbox launcher.

## Requirements

- [mise](https://mise.jdx.dev/)
- this repository checked out at `~/.pi`
- `~/.pi/bin` on `PATH`

For example:

```bash
export PATH="$HOME/.pi/bin:$PATH"
```

## Setup and updates

```bash
~/.pi/bin/pi-update
```

This command:

- links [`mise.toml`](mise.toml) as the global mise configuration;
- installs or upgrades Pi and the shared command-line tools; and
- updates the Pi packages declared in [`agent/settings.json`](agent/settings.json).

Run Pi normally from any project directory:

```bash
pi
pi -c
pi -p "Summarize this repository"
```

`bin/pi` is a transparent launcher for the mise-managed Pi executable. It does
not alter arguments, environment variables, session behavior, tools, or the
working directory.

## Configuration

Pi reads this checkout through its standard paths:

| Path | Purpose |
| --- | --- |
| `agent/settings.json` | Global Pi settings and installed packages. |
| `agent/extensions/` | Local Pi extensions. |
| `agent/skills/` | Local skills maintained by this repository. |
| `agent/APPEND_SYSTEM.md` | Additional global agent instructions. |
| `agent/mcp.json` | MCP adapter configuration. |
| `mise.toml` | Pi and shared CLI tool installation. |

Credentials, sessions, installed package contents, and other mutable state are
ignored by Git and remain under `~/.pi/agent` on the host.
