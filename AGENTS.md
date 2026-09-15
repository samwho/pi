# Agent Instructions

## Agent skills

Install and update shared agent skills in `~/.agents`. Do not duplicate a host skill under `~/.pi/agent/skills`.

## Tool installation

Prefer `mise` for runtimes and CLI tools. Check whether a tool is supported by
mise and use it whenever possible before adding a pacman, Composer, npm, or
custom installer. Use another installer when mise does not support the tool or
when system packages and extensions are required.
