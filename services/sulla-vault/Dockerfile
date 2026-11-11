FROM node:24-alpine AS build
WORKDIR /app

COPY packages/vault-crypto/package*.json ./packages/vault-crypto/
RUN cd packages/vault-crypto && npm ci --ignore-scripts
COPY packages/vault-crypto/tsconfig.json ./packages/vault-crypto/tsconfig.json
COPY packages/vault-crypto/src ./packages/vault-crypto/src
RUN cd packages/vault-crypto && npm run build

COPY services/sulla-vault/package.json ./services/sulla-vault/package.json
COPY vendor/sulla-core/sulla-domain-0.3.1-c5f7154.tgz ./vendor/sulla-core/sulla-domain-0.3.1-c5f7154.tgz
COPY vendor/sulla-core/sulla-foundation-0.1.1-7d4a6dd.tgz ./vendor/sulla-core/sulla-foundation-0.1.1-7d4a6dd.tgz
RUN cd services/sulla-vault && npm install --ignore-scripts
COPY services/sulla-vault/tsconfig.json ./services/sulla-vault/tsconfig.json
COPY services/sulla-vault/src ./services/sulla-vault/src
COPY services/sulla-vault/migrations ./services/sulla-vault/migrations
COPY services/sulla-vault/console ./services/sulla-vault/console
RUN cd services/sulla-vault && npm run build
RUN cd packages/vault-crypto && npm prune --omit=dev \
 && cd /app/services/sulla-vault && npm prune --omit=dev

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app/services/sulla-vault
RUN apk add --no-cache su-exec
COPY --from=build /app/services/sulla-vault/package.json ./package.json
COPY --from=build /app/services/sulla-vault/node_modules ./node_modules
COPY --from=build /app/services/sulla-vault/dist ./dist
COPY --from=build /app/services/sulla-vault/migrations ./migrations
COPY --from=build /app/services/sulla-vault/console ./console
COPY --from=build /app/packages/vault-crypto/package.json /app/packages/vault-crypto/package.json
COPY --from=build /app/packages/vault-crypto/dist /app/packages/vault-crypto/dist
COPY --from=build /app/packages/vault-crypto/node_modules /app/packages/vault-crypto/node_modules
COPY services/sulla-vault/entrypoint.sh /usr/local/bin/sulla-vault-entrypoint
RUN chmod 0755 /usr/local/bin/sulla-vault-entrypoint
EXPOSE 8787
ENTRYPOINT ["sulla-vault-entrypoint"]
CMD ["node", "dist/index.js"]
