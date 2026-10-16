FROM node:24-alpine AS build
WORKDIR /app

COPY packages/vault-crypto/package*.json ./packages/vault-crypto/
RUN cd packages/vault-crypto && npm ci --ignore-scripts
COPY packages/vault-crypto/tsconfig.json ./packages/vault-crypto/tsconfig.json
COPY packages/vault-crypto/src ./packages/vault-crypto/src
RUN cd packages/vault-crypto && npm run build

COPY services/sulla-vault/package.json ./services/sulla-vault/package.json
RUN cd services/sulla-vault && npm install --ignore-scripts
COPY services/sulla-vault/tsconfig.json ./services/sulla-vault/tsconfig.json
COPY services/sulla-vault/src ./services/sulla-vault/src
COPY services/sulla-vault/migrations ./services/sulla-vault/migrations
RUN cd services/sulla-vault && npm run build
RUN cd packages/vault-crypto && npm prune --omit=dev \
 && cd /app/services/sulla-vault && npm prune --omit=dev

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app/services/sulla-vault
COPY --from=build /app/services/sulla-vault/package.json ./package.json
COPY --from=build /app/services/sulla-vault/node_modules ./node_modules
COPY --from=build /app/services/sulla-vault/dist ./dist
COPY --from=build /app/services/sulla-vault/migrations ./migrations
COPY --from=build /app/packages/vault-crypto/package.json /app/packages/vault-crypto/package.json
COPY --from=build /app/packages/vault-crypto/dist /app/packages/vault-crypto/dist
COPY --from=build /app/packages/vault-crypto/node_modules /app/packages/vault-crypto/node_modules
USER node
EXPOSE 8787
CMD ["node", "dist/index.js"]
