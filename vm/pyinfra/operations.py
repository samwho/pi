from pyinfra.api.command import QuoteString, StringCommand
from pyinfra.api.operation import operation
from pyinfra.context import host
from pyinfra.facts.server import Users

from facts import MISE


@operation()
def user_without_groups(user: str, groups: list[str]):
    """Ensure a user is not a member of selected administrative groups."""

    current_groups = host.get_fact(Users).get(user, {}).get("groups", [])
    for group in groups:
        if group in current_groups:
            yield StringCommand("gpasswd", "--delete", QuoteString(user), QuoteString(group))


def _run_as_pi(*command):
    return StringCommand(
        "runuser",
        "-u",
        "pi",
        "--",
        "env",
        "HOME=/home/pi",
        *command,
    )


@operation()
def mise_install_and_upgrade():
    """Install and refresh every tool declared in the shared global config."""

    yield _run_as_pi(QuoteString(MISE), "install")
    yield _run_as_pi(QuoteString(MISE), "upgrade", "--yes")
