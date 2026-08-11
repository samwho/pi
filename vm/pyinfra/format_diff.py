#!/usr/bin/env python3
"""Render PyInfra's JSON dry-run plan as a compact, readable diff."""

import json
import re
import sys
from pathlib import Path


def plural(count: int, word: str) -> str:
    return f"{count} {word}{'' if count == 1 else 's'}"


def file_diffs(log: str) -> list[str]:
    """Extract unified file diffs from PyInfra's otherwise noisy stderr log."""

    output: list[str] = []
    capturing = False
    for line in log.splitlines():
        if re.match(r"^\s+\[[^]]+\] Will ", line):
            capturing = True
        elif capturing and re.match(r"^\s+\[[^]]+\] Ready:", line):
            capturing = False

        if capturing:
            output.append(line[4:] if line.startswith("    ") else line)

    while output and not output[-1].strip():
        output.pop()
    return output


def main() -> int:
    if len(sys.argv) != 3:
        print(f"usage: {Path(sys.argv[0]).name} PLAN_JSON PYINFRA_LOG", file=sys.stderr)
        return 2

    with Path(sys.argv[1]).open() as file:
        plan = json.load(file)["plan"]
    log = Path(sys.argv[2]).read_text()

    changes = [operation["name"] for operation in plan if operation["hosts_with_change"]]
    diffs = file_diffs(log)

    if not changes:
        print("No PyInfra changes.")
        return 0

    print("Changes")
    for name in changes:
        print(f"  + {name}")

    if diffs:
        print("\nFile diffs")
        print("\n".join(diffs))

    print(f"\n{plural(len(changes), 'change')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
