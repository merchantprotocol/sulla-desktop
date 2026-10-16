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
COPY --from=build /app/services/sulla-files/package.json ./package.json
COPY --from=build /app/services/sulla-files/node_modules ./node_modules
COPY --from=build /app/services/sulla-files/dist ./dist
COPY services/sulla-files/migrations ./migrations
RUN mkdir -p /var/lib/sulla-files/chunks && chown -R node:node /var/lib/sulla-files
USER node
EXPOSE 8792
CMD ["node","dist/index.js"]
