FROM node:22-alpine
WORKDIR /app
COPY services/sulla-tools/package.json ./package.json
RUN npm install --ignore-scripts --omit=dev
COPY services/sulla-tools/src ./services/sulla-tools/src
COPY pkg/sulla-desktop/agent ./pkg/sulla-desktop/agent
COPY packages/runtime-protocol/src ./packages/runtime-protocol/src
COPY pkg/sulla-desktop/runtime ./pkg/sulla-desktop/runtime
COPY pkg/sulla-desktop/vault-broker ./pkg/sulla-desktop/vault-broker
COPY tsconfig.json ./tsconfig.json
ENV NODE_ENV=production
WORKDIR /app/services/sulla-tools
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -q -O- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["/app/node_modules/.bin/tsx", "src/index.ts"]
