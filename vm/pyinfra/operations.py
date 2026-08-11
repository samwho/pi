from pyinfra import host
from pyinfra.api import QuoteString, StringCommand, operation
from pyinfra.facts.server import Users

from facts import (
    MISE,
    NODE_BIN,
    MiseLatestVersions,
    MiseTools,
    NpmGlobalPackages,
    NpmLatestVersions,
)


def _split_request(request: str):
    if "@" not in request[1:]:
        return request, "latest"
    return request.rsplit("@", 1)


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
def mise_tools(tools: list[str]):
    """
    Ensure global mise tools are configured and installed.

    `latest` requests are resolved during fact gathering, so this operation only
    emits `mise use` when the configured request or installed version has drifted.
    """

    current = host.get_fact(MiseTools)
    latest = host.get_fact(MiseLatestVersions, tools=tuple(tools))
    changed = []

    for request in tools:
        tool, requested_version = _split_request(request)
        entry = current.get(tool, {})
        resolved_version = latest.get(request) if requested_version == "latest" else requested_version
        if (
            not entry.get("installed")
            or entry.get("requested_version") != requested_version
            or not resolved_version
            or entry.get("version") != resolved_version
        ):
            changed.append(request)

    if changed:
        yield _run_as_pi(
            QuoteString(MISE),
            "use",
            "--global",
            *(QuoteString(request) for request in changed),
        )


@operation()
def mise_npm_packages(packages: list[str]):
    """Ensure global npm packages in mise's active Node installation."""

    current = host.get_fact(NpmGlobalPackages)
    names = [_split_request(request)[0] for request in packages]
    latest = host.get_fact(NpmLatestVersions, packages=tuple(names))
    changed = []

    for request in packages:
        package, requested_version = _split_request(request)
        resolved_version = latest.get(package) if requested_version == "latest" else requested_version
        if not resolved_version or current.get(package) != resolved_version:
            changed.append(request)

    if changed:
        yield _run_as_pi(
            f"PATH={NODE_BIN}:/usr/bin",
            QuoteString(f"{NODE_BIN}/npm"),
            "install",
            "--global",
            "--ignore-scripts",
            *(QuoteString(request) for request in changed),
        )
