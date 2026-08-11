#!/usr/bin/env python3
"""Render PyInfra's JSON dry-run plan as a polished terminal diff."""

import json
import re
import sys
from pathlib import Path

from rich.console import Console
from rich.panel import Panel
from rich.syntax import Syntax
from rich.table import Table
from rich.text import Text


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
    console = Console()

    changed_operations = [operation for operation in plan if operation["hosts_with_change"]]
    diffs = file_diffs(log)
    hosts = sorted(
        {
            host
            for operation in changed_operations
            for host in operation["hosts_with_change"]
        }
    )
    target = ", ".join(hosts) if hosts else "template"

    console.print()
    console.print(
        Text.assemble(
            ("PyInfra plan", "bold cyan"),
            ("  •  ", "dim"),
            (target, "bold"),
        ),
        justify="center",
    )

    if not changed_operations:
        console.print(
            Panel.fit(
                "[bold green]✓ No changes[/bold green]\n[dim]The template matches the deployment.[/dim]",
                border_style="green",
                padding=(0, 3),
            ),
            justify="center",
        )
        return 0

    table = Table.grid(expand=True, padding=(0, 1))
    table.add_column(width=2, no_wrap=True)
    table.add_column(ratio=1)
    for operation in changed_operations:
        table.add_row("[bold green]+[/bold green]", Text(operation["name"], style="bold"))

    console.print(
        Panel(
            table,
            title=f"[bold]{plural(len(changed_operations), 'planned change')}[/bold]",
            title_align="left",
            border_style="cyan",
            padding=(0, 1),
        )
    )

    if diffs:
        console.print(
            Panel(
                Syntax(
                    "\n".join(diffs),
                    "diff",
                    theme="ansi_dark",
                    word_wrap=False,
                    background_color="default",
                ),
                title="[bold]Managed file diffs[/bold]",
                title_align="left",
                border_style="magenta",
                padding=(0, 1),
            )
        )

    console.print(
        Text.assemble(
            ("● ", "green"),
            (plural(len(changed_operations), "change"), "bold"),
            (" would be applied", "dim"),
        ),
        justify="right",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
