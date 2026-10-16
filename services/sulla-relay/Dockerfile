FROM node:22-alpine AS build
WORKDIR /app

COPY services/sulla-relay/package.json ./services/sulla-relay/package.json
RUN cd services/sulla-relay && npm install --ignore-scripts && ln -s services/sulla-relay/node_modules /app/node_modules

COPY services/sulla-relay/tsconfig.json ./services/sulla-relay/tsconfig.json
COPY services/sulla-relay/src ./services/sulla-relay/src
COPY services/sulla-relay/verify ./services/sulla-relay/verify
COPY pkg/rancher-desktop/runtime/relayProtocol.ts ./pkg/rancher-desktop/runtime/relayProtocol.ts
COPY pkg/rancher-desktop/runtime/relayTunnelClient.ts ./pkg/rancher-desktop/runtime/relayTunnelClient.ts
RUN cd services/sulla-relay && npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/services/sulla-relay/package.json ./services/sulla-relay/package.json
COPY --from=build /app/services/sulla-relay/node_modules ./services/sulla-relay/node_modules
COPY --from=build /app/services/sulla-relay/dist ./services/sulla-relay/dist
COPY --from=build /app/services/sulla-relay/verify ./services/sulla-relay/verify
WORKDIR /app/services/sulla-relay
USER node
EXPOSE 8790
ENTRYPOINT ["node"]
CMD ["dist/services/sulla-relay/src/index.js"]
