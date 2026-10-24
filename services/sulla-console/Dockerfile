# syntax=docker/dockerfile:1.7

FROM node:22.22.0-bookworm-slim AS build
WORKDIR /opt/sulla-console
COPY services/sulla-console/package.json services/sulla-console/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY services/sulla-console/tsconfig.json ./
COPY services/sulla-console/src ./src
RUN npm run build

FROM node:22.22.0-bookworm-slim AS runtime
ENV NODE_ENV=production SULLA_CONSOLE_PORT=8786
WORKDIR /opt/sulla-console
COPY services/sulla-console/package.json services/sulla-console/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --from=build /opt/sulla-console/dist ./dist
COPY services/sulla-console/src/migrations ./dist/migrations
COPY resources/sulla-console/public ./public
RUN useradd --system --uid 10001 --home-dir /opt/sulla-console --shell /usr/sbin/nologin sulla \
 && mkdir -p /var/lib/sulla-console \
 && chown -R sulla:sulla /opt/sulla-console /var/lib/sulla-console
USER sulla
EXPOSE 8786
CMD ["node", "dist/index.js"]
