FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY services/sulla-console/package.json ./package.json
COPY resources/sulla-console/server.mjs ./server.mjs
COPY resources/sulla-console/license.mjs ./license.mjs
COPY resources/sulla-console/public ./public
USER node
EXPOSE 8786
CMD ["node", "server.mjs"]
