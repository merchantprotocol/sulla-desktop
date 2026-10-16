FROM node:24-alpine AS build
WORKDIR /app/services/sulla-files
COPY services/sulla-files/package.json ./
RUN npm install --ignore-scripts
COPY services/sulla-files/tsconfig.json ./
COPY services/sulla-files/src ./src
RUN npm run build && npm prune --omit=dev
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache ffmpeg poppler-utils su-exec
COPY --from=build /app/services/sulla-files/package.json ./package.json
COPY --from=build /app/services/sulla-files/node_modules ./node_modules
COPY --from=build /app/services/sulla-files/dist ./dist
COPY services/sulla-files/migrations ./migrations
COPY services/sulla-files/entrypoint.sh /usr/local/bin/sulla-files-entrypoint
RUN mkdir -p /var/lib/sulla-files/chunks /data/files /backup && chown -R node:node /var/lib/sulla-files /data/files /backup
RUN chmod 0755 /usr/local/bin/sulla-files-entrypoint
VOLUME ["/var/lib/sulla-files", "/data/files"]
EXPOSE 8792
ENTRYPOINT ["sulla-files-entrypoint"]
CMD ["node","dist/index.js"]
