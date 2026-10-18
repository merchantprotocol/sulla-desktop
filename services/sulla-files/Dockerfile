FROM node:24-alpine AS build
COPY services/sulla-files/scripts/build-potion-model.mjs /tmp/build-potion-model.mjs
RUN node /tmp/build-potion-model.mjs /app/models/potion-retrieval-32M && rm /app/models/potion-retrieval-32M/model.safetensors
WORKDIR /app
COPY packages/vault-crypto/package*.json ./packages/vault-crypto/
RUN cd packages/vault-crypto && npm ci --ignore-scripts
COPY packages/vault-crypto/tsconfig.json ./packages/vault-crypto/tsconfig.json
COPY packages/vault-crypto/src ./packages/vault-crypto/src
RUN cd packages/vault-crypto && npm run build
WORKDIR /app/services/sulla-files
COPY services/sulla-files/package.json ./
RUN npm install --ignore-scripts
COPY services/sulla-files/tsconfig.json ./
COPY services/sulla-files/vite.config.ts ./
COPY services/sulla-files/src ./src
COPY services/sulla-files/web-src ./web-src
COPY pkg/rancher-desktop/pages/files/FilesBrowser.vue /app/pkg/rancher-desktop/pages/files/FilesBrowser.vue
COPY pkg/rancher-desktop/pages/files/types.ts /app/pkg/rancher-desktop/pages/files/types.ts
RUN npm run build && npm prune --omit=dev
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app/services/sulla-files
RUN apk add --no-cache antiword ffmpeg poppler-utils su-exec tesseract-ocr tesseract-ocr-data-eng unzip
COPY --from=build /app/services/sulla-files/package.json ./package.json
COPY --from=build /app/services/sulla-files/node_modules ./node_modules
COPY --from=build /app/services/sulla-files/dist ./dist
COPY --from=build /app/models /app/models
COPY --from=build /app/packages/vault-crypto/package.json /app/packages/vault-crypto/package.json
COPY --from=build /app/packages/vault-crypto/dist /app/packages/vault-crypto/dist
COPY --from=build /app/packages/vault-crypto/node_modules /app/packages/vault-crypto/node_modules
COPY services/sulla-files/migrations ./migrations
COPY --from=build /app/services/sulla-files/web ./web
COPY services/sulla-files/entrypoint.sh /usr/local/bin/sulla-files-entrypoint
RUN mkdir -p /var/lib/sulla-files/chunks /data/files /backup && chown -R node:node /var/lib/sulla-files /data/files /backup
RUN chmod 0755 /usr/local/bin/sulla-files-entrypoint
VOLUME ["/var/lib/sulla-files", "/data/files"]
EXPOSE 8792
ENTRYPOINT ["sulla-files-entrypoint"]
CMD ["node","dist/index.js"]
