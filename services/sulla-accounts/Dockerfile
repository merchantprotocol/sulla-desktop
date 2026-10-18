# syntax=docker/dockerfile:1.7

FROM node:22.22.0-bookworm-slim AS build
WORKDIR /opt/sulla-accounts
COPY services/sulla-accounts/package.json ./package.json
RUN npm install --ignore-scripts --no-audit --no-fund
COPY services/sulla-accounts/tsconfig.json ./tsconfig.json
COPY services/sulla-accounts/src ./src
RUN npm run build

FROM node:22.22.0-bookworm-slim AS runtime
ARG KEYCLOAK_VERSION=26.3.3
ARG KEYCLOAK_SHA256=9b4185434b8ad3577373a8d806f95dce182bfff8f7c35a8ba959506d94c04420
ENV NODE_ENV=production \
    SULLA_ACCOUNTS_PORT=3020 \
    KEYCLOAK_VERSION=${KEYCLOAK_VERSION} \
    KC_DB=postgres \
    KC_HEALTH_ENABLED=true
WORKDIR /opt/sulla-accounts

RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates curl openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/* \
    && curl --fail --silent --show-error --location \
      "https://github.com/keycloak/keycloak/releases/download/${KEYCLOAK_VERSION}/keycloak-${KEYCLOAK_VERSION}.tar.gz" \
      --output /tmp/keycloak.tar.gz \
    && echo "${KEYCLOAK_SHA256}  /tmp/keycloak.tar.gz" | sha256sum --check --strict \
    && mkdir -p /opt/keycloak \
    && tar -xzf /tmp/keycloak.tar.gz --strip-components=1 -C /opt/keycloak \
    && rm /tmp/keycloak.tar.gz \
    && mkdir -p /licenses/keycloak \
    && /opt/keycloak/bin/kc.sh build --db=postgres --health-enabled=true

COPY services/sulla-accounts/package.json ./package.json
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
COPY --from=build /opt/sulla-accounts/dist ./dist
COPY services/sulla-accounts/migrations ./migrations
COPY services/sulla-accounts/entrypoint.sh /usr/local/bin/sulla-accounts-entrypoint
COPY services/sulla-accounts/THIRD_PARTY_NOTICES.md /licenses/THIRD_PARTY_NOTICES.md
COPY services/sulla-accounts/THIRD_PARTY_NOTICES.md /opt/sulla-accounts/THIRD_PARTY_NOTICES.md
COPY services/sulla-accounts/LICENSES /licenses/keycloak/LICENSES

RUN chmod 0755 /usr/local/bin/sulla-accounts-entrypoint \
    && useradd --system --uid 10001 --home-dir /opt/sulla-accounts --shell /usr/sbin/nologin sulla \
    && mkdir -p /opt/keycloak/data/import \
    && chown -R sulla:sulla /opt/sulla-accounts /opt/keycloak

USER sulla
EXPOSE 3020 8080
ENTRYPOINT ["/usr/local/bin/sulla-accounts-entrypoint"]