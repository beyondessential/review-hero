# Claude CLI sandbox — used by Review Hero to run Claude in an isolated
# container without sudo, without secrets in the environment, and without
# access to the host's credentials or privileged capabilities.
#
# Build:
#   docker build -t claude-sandbox:latest -f docker/Dockerfile docker/
#
# The image is built once per workflow run and cached via Docker layer caching.

FROM node:22-slim

# Install git (needed by the commit helper and Claude's scoped git tools)
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally while we're still root
RUN npm install -g @anthropic-ai/claude-code

# Create a non-root user with no sudo, no password, no login shell.
# Use a high UID to avoid collisions with host UIDs on mounted volumes.
RUN useradd -m -u 65532 -s /bin/sh claude

# Drop to non-root — no sudo is installed, so there's no escalation path
USER claude

WORKDIR /workspace
