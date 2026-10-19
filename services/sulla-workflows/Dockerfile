FROM node:22-alpine AS build
WORKDIR /app

COPY services/sulla-workflows/package*.json ./services/sulla-workflows/
RUN cd services/sulla-workflows && npm ci --ignore-scripts

COPY services/sulla-workflows/tsconfig.json ./services/sulla-workflows/tsconfig.json
COPY services/sulla-workflows/src ./services/sulla-workflows/src
COPY pkg/rancher-desktop/agent/workflow/WorkflowPlaybook.ts ./pkg/rancher-desktop/agent/workflow/WorkflowPlaybook.ts
COPY pkg/rancher-desktop/agent/workflow/types.ts ./pkg/rancher-desktop/agent/workflow/types.ts
COPY pkg/rancher-desktop/agent/workflow/workflowConcurrency.ts ./pkg/rancher-desktop/agent/workflow/workflowConcurrency.ts
COPY pkg/rancher-desktop/pages/editor/workflow/types.ts ./pkg/rancher-desktop/pages/editor/workflow/types.ts
COPY pkg/rancher-desktop/runtime/containerRuntime.ts ./pkg/rancher-desktop/runtime/containerRuntime.ts
COPY pkg/rancher-desktop/runtime/capabilityToken.ts ./pkg/rancher-desktop/runtime/capabilityToken.ts
RUN cd services/sulla-workflows && npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache su-exec
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
