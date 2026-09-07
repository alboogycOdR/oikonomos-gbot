# Steel image pin verified live on 2026-09-07 (TASK-186).  A digest, rather
# than the moving `latest` tag, is required by ADR-006 R14.
FROM ghcr.io/steel-dev/steel-browser@sha256:54750fc5deb3102b5f8cc844abfdc7ec46298addfdc5dd5fb40a8382b02a5819 AS steel-browser

# steel-dev/steel-mcp-server v2.0.1 resolves to this reviewed commit.  It is
# built from its official source because the project does not publish an npm
# package for the stdio entrypoint.
FROM node:22.17.0-bookworm-slim AS steel-mcp-build
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && update-ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone https://github.com/steel-dev/steel-mcp-server.git . \
 && git checkout --detach 4c0c583a3704ea3605fe3c72d7d0e9a9b1b94994 \
 && npm ci --ignore-scripts \
 && npm run build \
 && npm prune --omit=dev

FROM steel-browser

# The browser server is root-owned so it can access D3; the agent command is
# subsequently dropped to the unprivileged `sandbox` identity by the existing
# egress entrypoint copied from office-base.
RUN npm install --global @anthropic-ai/claude-code@2.1.263 \
 && useradd --create-home --uid 10001 sandbox \
 && mkdir -p /opt/oikonomos /etc/claude-code /oikonomos/secrets/browser-profiles \
 && chown root:root /oikonomos/secrets /oikonomos/secrets/browser-profiles \
 && chmod 0700 /oikonomos/secrets /oikonomos/secrets/browser-profiles

# dist alone isn't runnable: the build is plain tsc (no bundler), so every
# import of an external package (e.g. @modelcontextprotocol/server) resolves
# at runtime through node_modules, not something dist embeds. Confirmed live
# 2026-09-07: omitting this line produces ERR_MODULE_NOT_FOUND the moment the
# MCP stdio server starts, closing the connection before the CLI ever sees a
# steel_* tool — the actual `npm prune --omit=dev` step above already strips
# this down to production-only deps, so nothing extra ships by copying it.
COPY --from=steel-mcp-build /src/node_modules /opt/oikonomos/steel-mcp/node_modules
COPY --from=steel-mcp-build /src/dist /opt/oikonomos/steel-mcp/dist
COPY packages/harness-factory/dist/sandboxHook.js /opt/oikonomos/sandboxHook.js
COPY infra/sandbox/images/office-base/managed-settings.json /etc/claude-code/managed-settings.json
COPY infra/sandbox/images/office-base/egress-entrypoint.mjs /opt/oikonomos/egress-entrypoint.mjs
COPY infra/sandbox/images/office-browser/browser-entrypoint.sh /opt/oikonomos/browser-entrypoint.sh

RUN chown -R root:root /opt/oikonomos /etc/claude-code \
 && chmod 0444 /etc/claude-code/managed-settings.json /opt/oikonomos/sandboxHook.js \
 && chmod 0555 /opt/oikonomos/egress-entrypoint.mjs /opt/oikonomos/browser-entrypoint.sh

WORKDIR /workspace
ENTRYPOINT ["/opt/oikonomos/browser-entrypoint.sh"]
CMD ["tail", "-f", "/dev/null"]
