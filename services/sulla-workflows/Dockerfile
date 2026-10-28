FROM node:22-alpine AS build
WORKDIR /app

COPY services/sulla-workflows/package*.json ./services/sulla-workflows/
RUN cd services/sulla-workflows && npm ci --ignore-scripts

COPY services/sulla-workflows/tsconfig.json ./services/sulla-workflows/tsconfig.json
COPY services/sulla-workflows/src ./services/sulla-workflows/src
COPY packages/workflow-engine/src ./packages/workflow-engine/src
COPY packages/runtime-protocol/src ./packages/runtime-protocol/src
COPY pkg/sulla-desktop/runtime/containerRuntime.ts ./pkg/sulla-desktop/runtime/containerRuntime.ts
RUN cd services/sulla-workflows && npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache util-linux && mkdir -p /run/sulla-workflows-bootstrap && chmod 0700 /run/sulla-workflows-bootstrap
COPY --from=build /app/services/sulla-workflows/package.json ./services/sulla-workflows/package.json
COPY --from=build /app/services/sulla-workflows/node_modules ./services/sulla-workflows/node_modules
COPY --from=build /app/services/sulla-workflows/dist ./services/sulla-workflows/dist
COPY services/sulla-workflows/migrations ./services/sulla-workflows/migrations
COPY services/sulla-workflows/ui ./services/sulla-workflows/ui
COPY services/sulla-workflows/entrypoint.sh /usr/local/bin/sulla-workflows-entrypoint
RUN chmod 0755 /usr/local/bin/sulla-workflows-entrypoint
WORKDIR /app/services/sulla-workflows
EXPOSE 8788
ENTRYPOINT ["/usr/local/bin/sulla-workflows-entrypoint"]
CMD ["node", "dist/services/sulla-workflows/src/manager.js"]
