# Official Arch Linux amd64 manifest, pinned rather than using a moving tag.
# It is intentionally amd64: the official image does not publish ARM64.
FROM archlinux@sha256:a674898d53cc63b1af4023a468ccddc25ed9d7aecc3996f16171838a57085999

# Keep the official Arch image's rolling-release update/install flow. Docker's
# restricted build environment cannot use pacman's Landlock/alpm sandbox.
# The Docker and RootlessKit packages are only used by the opt-in pi-dind mode.
RUN sed -i 's/^#DisableSandbox/DisableSandbox/' /etc/pacman.conf \
  && pacman -Syu --noconfirm \
  && pacman -S --noconfirm --needed \
     bash base-devel ca-certificates chromium curl docker docker-buildx fd git \
     iproute2 iptables-nft jq make neovim ripgrep rootlesskit rsync shadow slirp4netns \
  && pacman -Scc --noconfirm

# pi-skills' browser-start script currently uses Chrome's macOS path. Provide a
# Linux-compatible headless shim at that path, including container-safe flags.
RUN mkdir -p "/Applications/Google Chrome.app/Contents/MacOS" \
  && printf '%s\n' '#!/bin/sh' \
     'exec /usr/bin/chromium --headless=new --no-sandbox --disable-dev-shm-usage "$@"' \
     > "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  && chmod 0755 "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# Pi never runs as root. The subordinate-ID ranges and setuid helpers are
# required only when RootlessKit creates pi-dind's nested user namespace.
RUN useradd --create-home --uid 1000 --shell /bin/bash pi \
  && printf 'pi:100000:65536\n' > /etc/subuid \
  && printf 'pi:100000:65536\n' > /etc/subgid \
  && mkdir -p /home/pi/.local/share/docker /home/pi/.pi/agent/sessions /home/pi/.pi/state \
     /run/pi-docker /run/user/1000 /workspace \
  && chown -R pi:pi /home/pi /run/pi-docker /run/user/1000 /workspace \
  && chmod 4755 /usr/bin/newuidmap /usr/bin/newgidmap

# Keep tool installations and Pi's immutable, image-baked configuration under
# pi's home. Runtime credentials and sessions are mounted separately by pi.
ENV HOME="/home/pi"
ENV MISE_DATA_DIR="/home/pi/.local/share/mise"
ENV MISE_TRUSTED_CONFIG_PATHS="/workspace"
ENV PATH="/home/pi/.local/share/mise/installs/node/latest/bin:/home/pi/.local/bin:/home/pi/.local/share/mise/shims:${PATH}"
ENV DOCKER_HOST="unix:///run/pi-docker/docker.sock"

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
  && npm install -g --ignore-scripts \
     @earendil-works/pi-coding-agent chrome-devtools-mcp

USER root

# Bake non-secret Pi configuration into the image. .dockerignore excludes
# credentials and sessions; the launcher's named volumes supply mutable state.
COPY --chown=pi:pi agent/ /home/pi/.pi/agent/
COPY --chown=pi:pi agent/mcp.json /home/pi/.pi/agent/mcp.json
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/pi-entrypoint
COPY --chmod=0755 docker/dockerd-entrypoint.sh /usr/local/bin/pi-dockerd-entrypoint
COPY --chmod=0755 docker/network-lockdown.sh /usr/local/bin/pi-network-lockdown

# Authentication and model metadata must survive ephemeral agent containers but
# must not be image layers. These links resolve into the runtime state volume.
RUN test ! -e /home/pi/.pi/agent/auth.json \
  && test ! -e /home/pi/.pi/agent/models-store.json \
  && ln -s /home/pi/.pi/state/auth.json /home/pi/.pi/agent/auth.json \
  && ln -s /home/pi/.pi/state/models-store.json /home/pi/.pi/agent/models-store.json

WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/pi-entrypoint"]
