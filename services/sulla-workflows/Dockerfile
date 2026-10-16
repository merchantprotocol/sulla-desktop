FROM node:22-alpine AS build
WORKDIR /app

COPY services/sulla-workflows/package*.json ./services/sulla-workflows/
RUN cd services/sulla-workflows && npm ci --ignore-scripts

COPY services/sulla-workflows/tsconfig.json ./services/sulla-workflows/tsconfig.json
COPY services/sulla-workflows/src ./services/sulla-workflows/src
COPY pkg/rancher-desktop/agent/workflow/WorkflowPlaybook.ts ./pkg/rancher-desktop/agent/workflow/WorkflowPlaybook.ts
COPY pkg/rancher-desktop/agent/workflow/types.ts ./pkg/rancher-desktop/agent/workflow/types.ts
COPY pkg/rancher-desktop/pages/editor/workflow/types.ts ./pkg/rancher-desktop/pages/editor/workflow/types.ts
COPY pkg/rancher-desktop/runtime/containerRuntime.ts ./pkg/rancher-desktop/runtime/containerRuntime.ts
RUN cd services/sulla-workflows && npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/services/sulla-workflows/package.json ./services/sulla-workflows/package.json
COPY --from=build /app/services/sulla-workflows/node_modules ./services/sulla-workflows/node_modules
COPY --from=build /app/services/sulla-workflows/dist ./services/sulla-workflows/dist
COPY services/sulla-workflows/migrations ./services/sulla-workflows/migrations
WORKDIR /app/services/sulla-workflows
USER node
EXPOSE 8788
ENTRYPOINT ["node"]
CMD ["dist/services/sulla-workflows/src/manager.js"]
