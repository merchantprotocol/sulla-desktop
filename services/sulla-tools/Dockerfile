FROM node:22-alpine
WORKDIR /app
COPY services/sulla-tools/package.json ./package.json
RUN npm install --ignore-scripts --omit=dev
COPY services/sulla-tools/src ./services/sulla-tools/src
COPY pkg/rancher-desktop/agent ./pkg/rancher-desktop/agent
COPY pkg/rancher-desktop/runtime ./pkg/rancher-desktop/runtime
COPY tsconfig.json ./tsconfig.json
ENV NODE_ENV=production
WORKDIR /app/services/sulla-tools
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -q -O- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["/app/node_modules/.bin/tsx", "src/index.ts"]
