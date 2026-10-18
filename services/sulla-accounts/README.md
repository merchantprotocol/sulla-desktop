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

Server deployments provide database usernames and passwords only through the individual
file-secret paths in the Compose definition. The root entrypoint copies exact secret files into
a private tmpfs, constructs the Accounts database URL in a mode-`0600` file, and then launches
both long-lived processes as UID `10001`. Keycloak and Accounts use separate databases, while
both may be hosted by the same PostgreSQL server. No raw database or Keycloak bootstrap secret
is placed in the Compose environment.
Every server start idempotently reconciles the versioned `sulla` realm configuration while
preserving existing users and the durable Keycloak database. It maintains a public native
PKCE client named `sulla-desktop`, with only
`http://127.0.0.1:3020/v1/oidc/callback`, and a separate confidential hosted client named
`sulla-web`. The default `sulla-audience-sulla-membership` client scope issues the base
`sulla-membership` audience. Explicit resource audiences remain opt-in through client scopes
named `sulla-audience-<audience>`. `/opt/keycloak/data` must be backed by a durable volume.

The reverse proxy publishes only the stable `/auth` issuer path, public authority metadata,
the subject-scoped membership resolver and required owner
protocol paths. Desktop bootstrap remains private and exists only in desktop mode.
Private `/v1/admin/` and `/v1/private/` routes and the loopback Keycloak
management endpoint are not published by the packaged gateway configuration.

`deploy/accounts/compose.preview.yaml` is a synthetic smoke topology: one local
desktop broker and two isolated server authorities share only the PostgreSQL
host, with separate Accounts and Keycloak databases and durable Keycloak data
volumes for each authority. The local broker is published directly on `127.0.0.1:3020`.
The gateway publishes the hosted authorities as `authority-a.localhost` and
`authority-b.localhost` on port `8787`; those names resolve to the gateway on the Compose
network and to loopback in the host browser, so OIDC discovery reaches the same authority
origins from both places. Its fixture secrets
are intentionally not committed. Provide local `0600` Accounts files plus
`preview-secrets/tls/{ca.crt,tls.crt,tls.key}` from a development CA whose
certificate covers all three names before running it, and trust that CA in the
browser used for the synthetic preview. Run `prepare-preview.sh` to create fresh uncommitted
file secrets and the short-lived synthetic CA, then start Compose. The local Desktop broker is
forwarded directly to `http://127.0.0.1:3020`, matching the native callback exactly; the two
hosted authorities remain on the trusted HTTPS gateway. After readiness,
`preview-provision.sh` idempotently creates isolated synthetic subjects and memberships in the
two authorities. Neither script reads or writes any live Vault, wallet, or user data.
