# Agent Instructions

## Agent skills

Manage agent skills on the host, not in `vm/pyinfra/deploy.py`. Install and update skills in the host Pi setup (normally `~/.agents`), then copy the complete directory into guest VMs through the host-managed setup when it exists. Do not duplicate a host skill under `~/.pi/agent/skills`, and do not add skill installation or update commands to VM deployment provisioning.

## Tool installation

Prefer `mise` for runtimes and CLI tools. Check whether a tool is supported by
mise and use it whenever possible before adding a pacman, Composer, npm, or
custom installer. Use another installer when mise does not support the tool or
when system packages and extensions are required.
