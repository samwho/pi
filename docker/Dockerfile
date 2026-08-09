# The official Arch image is x86_64-only. The sandbox runs it under
# emulation on Apple Silicon for consistency with the upstream image.
FROM archlinux:latest

# Arch is rolling-release; upgrade the base system before installing anything
# else so all packages come from the same current repository snapshot. Docker's
# restricted build environment cannot use pacman's Landlock/alpm sandbox.
RUN sed -i 's/^#DisableSandbox/DisableSandbox/' /etc/pacman.conf \
  && pacman -Syu --noconfirm \
  && pacman -S --noconfirm --needed \
     bash base-devel ca-certificates chromium curl fd git neovim \
     ripgrep rsync \
  && pacman -Scc --noconfirm

# pi-skills' browser-start script currently uses Chrome's macOS path. Provide a
# Linux-compatible headless shim at that path, including the flags required by
# the capability-restricted container.
RUN mkdir -p "/Applications/Google Chrome.app/Contents/MacOS" \
  && printf '%s\n' '#!/bin/sh' \
     'exec /usr/bin/chromium --headless=new --no-sandbox --disable-dev-shm-usage "$@"' \
     > "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  && chmod 0755 "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

RUN useradd --create-home --uid 1000 --shell /bin/bash pi \
  && mkdir -p /home/pi/.pi/agent/sessions /workspace \
  && chown -R pi:pi /home/pi /workspace

ENV HOME="/home/pi"
ENV MISE_DATA_DIR="/home/pi/.local/share/mise"
# Trust mise configs in the mounted project without prompting in the sandbox.
ENV MISE_TRUSTED_CONFIG_PATHS="/workspace"
ENV PATH="/home/pi/.local/bin:/home/pi/.local/share/mise/shims:${PATH}"

USER pi

RUN curl --proto '=https' --tlsv1.2 -fsSL https://mise.run | sh \
  && mise use --global node@latest \
  && mise use --global bun@latest rust@latest uv@latest python@latest \
  && mise use --global npm:@biomejs/biome@latest \
  && node --version \
  && npm --version \
  && bun --version \
  && rustc --version \
  && cargo --version \
  && uv --version \
  && python --version \
  && biome --version \
  && chromium --version \
  && npm install -g --ignore-scripts @earendil-works/pi-coding-agent

WORKDIR /workspace
ENTRYPOINT ["pi"]
