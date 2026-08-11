import json
import shlex

from pyinfra.api.facts import FactBase

MISE = "/home/pi/.local/bin/mise"
NODE_BIN = "/home/pi/.local/share/mise/installs/node/latest/bin"


def _as_pi(command: str) -> str:
    return f"runuser -u pi -- env HOME=/home/pi bash -lc {shlex.quote(command)}"


class MiseTools(FactBase):
    """Return globally configured mise tools and their active installations."""

    default = dict

    def requires_command(self) -> str:
        return MISE

    def command(self) -> str:
        return _as_pi(f"{MISE} ls --global --json")

    def process(self, output):
        data = json.loads("\n".join(output))
        return {
            tool: next((entry for entry in entries if entry.get("active")), entries[0])
            for tool, entries in data.items()
            if entries
        }


class MiseLatestVersions(FactBase):
    """Resolve mise `latest` requests so the operation can detect upgrades."""

    default = dict

    def requires_command(self, tools) -> str:
        return MISE

    def command(self, tools) -> str:
        lines = []
        for tool in tools:
            quoted = shlex.quote(tool)
            lines.append(f"printf '%s\\t%s\\n' {quoted} \"$({MISE} latest {quoted})\"")
        return _as_pi("; ".join(lines))

    def process(self, output):
        return dict(line.split("\t", 1) for line in output if "\t" in line)


class NpmGlobalPackages(FactBase):
    """Return packages installed into mise's active global Node installation."""

    default = dict

    def requires_command(self) -> str:
        return f"{NODE_BIN}/npm"

    def command(self) -> str:
        return _as_pi(f"PATH={NODE_BIN}:/usr/bin {NODE_BIN}/npm list -g --depth=0 --json")

    def process(self, output):
        data = json.loads("\n".join(output))
        return {
            name: details.get("version")
            for name, details in data.get("dependencies", {}).items()
            if details.get("version")
        }


class NpmLatestVersions(FactBase):
    """Resolve current npm registry versions for declarative latest packages."""

    default = dict

    def requires_command(self, packages) -> str:
        return f"{NODE_BIN}/npm"

    def command(self, packages) -> str:
        lines = []
        for package in packages:
            quoted = shlex.quote(package)
            lines.append(
                f"printf '%s\\t%s\\n' {quoted} \"$({NODE_BIN}/npm view {quoted}@latest version)\""
            )
        return _as_pi(f"PATH={NODE_BIN}:/usr/bin; export PATH; " + "; ".join(lines))

    def process(self, output):
        return dict(line.split("\t", 1) for line in output if "\t" in line)
