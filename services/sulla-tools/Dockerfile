FROM node:22-alpine
WORKDIR /app
COPY services/sulla-tools/package.json ./services/sulla-tools/package.json
COPY vendor/sulla-core/sulla-foundation-0.1.0-1c11fa5.tgz ./vendor/sulla-core/sulla-foundation-0.1.0-1c11fa5.tgz
RUN corepack prepare yarn@1.22.22 --activate \
  && cd services/sulla-tools \
  && yarn install --production --ignore-scripts --non-interactive \
  && ln -s services/sulla-tools/node_modules /app/node_modules \
  && test -f /app/node_modules/@sulla/foundation/dist/index.js
COPY services/sulla-tools/src ./services/sulla-tools/src
COPY pkg/sulla-desktop/agent ./pkg/sulla-desktop/agent
COPY packages/runtime-protocol/src ./packages/runtime-protocol/src
COPY packages/relay-protocol/src ./packages/relay-protocol/src
COPY pkg/sulla-desktop/runtime ./pkg/sulla-desktop/runtime
COPY pkg/sulla-desktop/vault-broker ./pkg/sulla-desktop/vault-broker
COPY pkg/sulla-desktop/utils ./pkg/sulla-desktop/utils
# Preserve the root ESM package boundary for TypeScript imported from pkg/.
# Without it, tsx loads those modules as CommonJS and named imports fail.
COPY package.json ./package.json
# First-run credentials only exist in Electron's main process. Agent modules
# also run in this container, so give their guarded lookups an inert authority
# instead of copying the Electron-only store (and its entire main-process graph).
COPY services/sulla-tools/src/pendingCredentials.container.ts ./pkg/sulla-desktop/main/firstRun/pendingCredentials.ts
COPY tsconfig.json ./tsconfig.json
# Keep the container authority inert even as Desktop's first-run module evolves.
RUN ./node_modules/.bin/tsx -e "import('/app/pkg/sulla-desktop/main/firstRun/pendingCredentials.ts').then(m=>{if(m.getPendingCredential('grok')!==undefined||m.hasPendingCredential('grok'))process.exit(1)})"
# Import the real catalog entrypoint so every manifest/registry dependency must
# resolve while the image is built, rather than failing later in production.
RUN ./node_modules/.bin/tsx -e "import('./services/sulla-tools/src/catalog.ts').then(({initializeCatalog})=>initializeCatalog())"
ENV NODE_ENV=production
WORKDIR /app/services/sulla-tools
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -q -O- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["/app/node_modules/.bin/tsx", "src/index.ts"]
