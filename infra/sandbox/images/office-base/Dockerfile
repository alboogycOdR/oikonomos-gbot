# Built from the repository root after `pnpm --filter @oikonomos/harness-factory build`.
# Node 22 matches the workspace's >=22 engine requirement; the exact Claude CLI
# version is ADR-015's reviewed hook contract.
FROM node:22.17.0-bookworm-slim

RUN npm install --global @anthropic-ai/claude-code@2.1.263 \
 && mkdir -p /opt/oikonomos /etc/claude-code \
 && useradd --create-home --uid 10001 sandbox

# This is compiled JavaScript, deliberately not the TypeScript source.
COPY packages/harness-factory/dist/sandboxHook.js /opt/oikonomos/sandboxHook.js
COPY infra/sandbox/images/office-base/managed-settings.json /etc/claude-code/managed-settings.json

# Managed settings are root-owned so a persistent role sandbox cannot disable
# its broker hook on one turn and evade it on the next. No matcher means every
# PreToolUse invocation is governed; timeout exceeds the hook's 10-second HTTP
# deadline so the hook, rather than Claude, owns timeout denial semantics.
RUN chown root:root /etc/claude-code/managed-settings.json /opt/oikonomos/sandboxHook.js \
 && chmod 0444 /etc/claude-code/managed-settings.json /opt/oikonomos/sandboxHook.js

USER sandbox
WORKDIR /workspace
CMD ["tail", "-f", "/dev/null"]
