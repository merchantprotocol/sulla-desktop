FROM node:24-alpine AS build
WORKDIR /app
COPY services/sulla-projects/package.json ./package.json
RUN npm install --ignore-scripts
COPY services/sulla-projects/tsconfig.json ./tsconfig.json
COPY services/sulla-projects/src ./src
RUN npm run build

FROM node:24-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
ENV NODE_ENV=production SULLA_PROJECTS_PORT=8793
COPY services/sulla-projects/package.json ./package.json
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY services/sulla-projects/ui ./ui
COPY services/sulla-projects/entrypoint.sh /usr/local/bin/sulla-projects-entrypoint
RUN chmod 0755 /usr/local/bin/sulla-projects-entrypoint
EXPOSE 8793
ENTRYPOINT ["/usr/local/bin/sulla-projects-entrypoint"]
CMD ["node","dist/index.js"]
