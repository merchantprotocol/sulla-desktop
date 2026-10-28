# syntax=docker/dockerfile:1.7

FROM node:22.22.0-bookworm-slim AS build
WORKDIR /opt/sulla-accounts
COPY services/sulla-accounts/package.json ./package.json
COPY services/sulla-accounts/package-lock.json ./package-lock.json
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY services/sulla-accounts/tsconfig.json ./tsconfig.json
COPY services/sulla-accounts/src ./src
RUN npm run build

FROM node:22.22.0-bookworm-slim AS runtime
ENV NODE_ENV=production SULLA_ACCOUNTS_PORT=3020 SULLA_ACCOUNTS_MODE=desktop
WORKDIR /opt/sulla-accounts
RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY services/sulla-accounts/package.json ./package.json
COPY services/sulla-accounts/package-lock.json ./package-lock.json
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --from=build /opt/sulla-accounts/dist ./dist
COPY services/sulla-accounts/migrations ./migrations
COPY services/sulla-accounts/entrypoint.sh /usr/local/bin/sulla-accounts-entrypoint
RUN chmod 0755 /usr/local/bin/sulla-accounts-entrypoint \
    && useradd --system --uid 10001 --home-dir /opt/sulla-accounts --shell /usr/sbin/nologin sulla \
    && chown -R sulla:sulla /opt/sulla-accounts
EXPOSE 3020
ENTRYPOINT ["/usr/local/bin/sulla-accounts-entrypoint"]
