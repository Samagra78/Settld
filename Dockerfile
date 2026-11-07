# Settld backend: API server + watcher/keeper that runs the Chainlink CRE workflows (cre CLI, simulate --broadcast).
# Needs env vars from server/.env and cre/.env (see docs/DEPLOY.md), plus CRE_API_KEY and MONGODB_URI.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates unzip gnupg git bash dos2unix \
 && rm -rf /var/lib/apt/lists/*

# Bun (CRE workflows are TypeScript compiled with bun)
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.4"
# Chainlink CRE CLI (official installer, verifies the binary signature); authenticates with CRE_API_KEY at runtime.
# Optional: only needed when the host also runs the automation (AUTOMATION_ENABLED=true). Plan B hosts the API only.
RUN (curl -sSL https://cre.chain.link/install.sh | bash) || echo "CRE CLI not installed — fine for an API-only host"
ENV PATH="/root/.bun/bin:/root/.cre/bin:${PATH}"

WORKDIR /app
# the backend (server, shared code, CRE workflows) and the website it serves (client); contracts stay out
COPY shared ./shared
COPY cre ./cre
COPY server ./server
COPY client ./client

RUN cd shared && (bun install --frozen-lockfile || bun install)
RUN for wf in cre/wf0-certify cre/wf1-verify cre/wf3-court cre/ping; do (cd "$wf" && (bun install --frozen-lockfile || bun install)); done
RUN cd server && (npm ci --omit=dev || npm install --omit=dev) && npm install --no-save tsx
# the website: built once here, served by the API server from client/dist (same address, so the login cookie is first-party)
# the Circle app id is public (it ships in the site's JavaScript anyway)
RUN cd client && npm ci && VITE_CIRCLE_APP_ID=bea33821-add4-5661-bbb7-59fa472dc087 npm run build && rm -rf node_modules

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN dos2unix /app/docker-entrypoint.sh && chmod +x /app/docker-entrypoint.sh
CMD ["/app/docker-entrypoint.sh"]
