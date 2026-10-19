FROM node:22-alpine AS build
WORKDIR /app
COPY services/sulla-workflows/package*.json ./services/sulla-workflows/
RUN cd services/sulla-workflows && npm ci --ignore-scripts
COPY services/sulla-agents ./services/sulla-agents
COPY pkg/rancher-desktop/runtime/containerRuntime.ts ./pkg/rancher-desktop/runtime/containerRuntime.ts
COPY pkg/rancher-desktop/runtime/capabilityToken.ts ./pkg/rancher-desktop/runtime/capabilityToken.ts
RUN ln -s ../sulla-workflows/node_modules services/sulla-agents/node_modules \
 && cd services/sulla-agents && ./node_modules/.bin/tsc -p tsconfig.json

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache util-linux
COPY --from=build /app/services/sulla-workflows/node_modules ./services/sulla-agents/node_modules
COPY --from=build /app/services/sulla-agents/dist ./services/sulla-agents/dist
COPY services/sulla-agents/ui ./services/sulla-agents/ui
COPY services/sulla-agents/entrypoint.sh /usr/local/bin/sulla-agents-entrypoint
RUN chmod 0755 /usr/local/bin/sulla-agents-entrypoint
WORKDIR /app/services/sulla-agents
EXPOSE 8789
ENTRYPOINT ["/usr/local/bin/sulla-agents-entrypoint"]
CMD ["node", "dist/services/sulla-agents/src/manager.js"]
