# Settld backend: API server + watcher/keeper that runs the Chainlink CRE workflows (cre CLI, simulate --broadcast).
# Needs env vars from server/.env and cre/.env (see docs/DEPLOY.md), plus CRE_API_KEY and MONGODB_URI.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates unzip gnupg git bash dos2unix \
 && rm -rf /var/lib/apt/lists/*

# Bun (CRE workflows are TypeScript compiled with bun)
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.4"
# Chainlink CRE CLI (official installer, verifies the binary signature); authenticates with CRE_API_KEY at runtime
RUN curl -sSL https://cre.chain.link/install.sh | bash
ENV PATH="/root/.bun/bin:/root/.cre/bin:${PATH}"

WORKDIR /app
# only what the backend needs: server, shared code, CRE workflows (contracts/client are not part of the backend image)
COPY shared ./shared
COPY cre ./cre
COPY server ./server

RUN cd shared && (bun install --frozen-lockfile || bun install)
RUN for wf in cre/wf0-certify cre/wf1-verify cre/wf3-court cre/ping; do (cd "$wf" && (bun install --frozen-lockfile || bun install)); done
RUN cd server && (npm ci --omit=dev || npm install --omit=dev) && npm install --no-save tsx

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN dos2unix /app/docker-entrypoint.sh && chmod +x /app/docker-entrypoint.sh
CMD ["/app/docker-entrypoint.sh"]
