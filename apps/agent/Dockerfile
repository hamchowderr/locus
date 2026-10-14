# The agent server. Build from the repository root:
#   docker build -f apps/agent/Dockerfile .
# Workspace packages ship TypeScript source, which Node runs directly (type stripping).
FROM node:22.22.0-bookworm-slim

ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --prod --filter "@locus/agent..." \
 && rm -rf /pnpm/store

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/agent/src/server.ts"]
