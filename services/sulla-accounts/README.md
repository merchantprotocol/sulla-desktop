# Sulla Accounts container

This image runs the Accounts broker in both modes. `desktop` (the default) runs
only the Node service on port `3020`; `server` runs the same service plus the
bundled Keycloak process in the same container. Keycloak listens only on
the private container network on port `8080`; its management endpoint remains
loopback-only on port `9000`. The separate gateway is the only published route.

The Node process is started directly as `node dist/index.js` so container
signals reach it without an npm wrapper. The broker owns the documented `SULLA_ACCOUNTS_*`
configuration and fails closed when required secret files or server settings are
missing. Secret files must be mounted read-only with mode `0600`.

Server deployments must provide a separate `SULLA_ACCOUNTS_KEYCLOAK_DATABASE_URL`
plus `SULLA_ACCOUNTS_KEYCLOAK_DATABASE_USERNAME` and
`SULLA_ACCOUNTS_KEYCLOAK_DATABASE_PASSWORD`
for Keycloak. This keeps Keycloak tables out of the Accounts-owned PostgreSQL
database while both databases may be hosted by the same PostgreSQL server.
The production Compose file also requires the complete
`SULLA_ACCOUNTS_DATABASE_URL` separately from the raw
`SULLA_POSTGRES_PASSWORD`; this avoids corrupting the broker URL when a strong
database password contains URI-reserved characters.
The image imports an initial `sulla` realm and public PKCE client whose id is
`SULLA_ACCOUNTS_KEYCLOAK_AUDIENCE`; later realm state lives in Keycloak's
database. `/opt/keycloak/data` must be backed by a durable volume.

The reverse proxy publishes only the stable `/auth` issuer path and the owner
protocol paths, including the bearer-protected bootstrap session endpoint.
Private `/v1/admin/` and `/v1/private/` routes and the loopback Keycloak
management endpoint are not published by the packaged gateway configuration.

`deploy/accounts/compose.preview.yaml` is a synthetic smoke topology: one local
desktop broker and two isolated server authorities share only the PostgreSQL
host, with separate Accounts and Keycloak databases and durable Keycloak data
volumes for each authority. The gateway publishes them as
`accounts.localhost`, `authority-a.localhost`, and `authority-b.localhost` on
port `8787`; those same names resolve to the gateway on the Compose network, so
OIDC discovery works from both containers and a browser. Its fixture secrets
are intentionally not committed. Provide local `0600` Accounts files plus
`preview-secrets/tls/{ca.crt,tls.crt,tls.key}` from a development CA whose
certificate covers all three names before running it, and trust that CA in the
browser used for the synthetic preview.
