# Sulla Accounts service contract

Sulla Accounts is the identity broker for one Sulla Desktop installation. It runs only in `desktop`
mode on port `3020` and accepts nothing else. The hosted/server side (Keycloak authority, hosted
console sessions, platform admin API, hosted membership resolver) lives in
[`merchantprotocol/sulla-server`](https://github.com/merchantprotocol/sulla-server) and is not
documented or shipped from this repository. Desktop only joins an org server as a client, by URL
and OIDC enrollment (below).

## Ownership and trust boundaries

- Accounts owns the installation-local profile, the per-owner authority/connection registry,
  encrypted OIDC sessions, and Sulla organization memberships/roles/groups.
- Accounts stores only its own Sulla-authority OIDC sessions. Third-party provider/integration
  refresh tokens and all provider decryption material remain Vault-owned; Accounts is not a
  generic integration secret store and does not migrate secrets out of Vault.
- A joined org server's authority owns hosted credentials and authentication ceremonies; Desktop never hosts them.
- A person is identified only by the tuple `(canonically serialized trusted issuer, stable subject)`. Email,
  display name, and username are attributes and never link identities.
- The local owner remains the owner of personal resources after Desktop joins an org server. Domain
  services continue to enforce their own resource ACLs and encryption.
- Owner APIs cannot administer organization memberships.
- Access and refresh tokens are encrypted at rest and are never returned by an API, written to
  logs, or included in model/tool-visible connection responses.
- Cached memberships are display hints only. A request requiring remote membership calls the
  trusted authority's configured membership endpoint; failure or revocation denies access.

## Process configuration

| Variable | Required | Contract |
| --- | --- | --- |
| `SULLA_ACCOUNTS_MODE` | no | `desktop` (default and only accepted value) |
| `SULLA_ACCOUNTS_PORT` | no | Broker port; default `3020` |
| `SULLA_ACCOUNTS_DATABASE_URL_FILE` | yes | `0600` file containing the PostgreSQL URL for the Accounts-owned database; the URL is never accepted directly in the environment |
| `SULLA_ACCOUNTS_BOOTSTRAP_SECRET_FILE` | yes | `0600` regular file used only to mint the local Desktop owner session |
| `SULLA_ACCOUNTS_SESSION_SECRET_FILE` | yes | `0600` file containing at least 32 bytes for short-lived broker JWTs |
| `SULLA_ACCOUNTS_ENCRYPTION_KEY_FILE` | yes | `0600` file containing exactly 32 raw bytes or 64 hexadecimal characters for AES-256-GCM |
| `SULLA_ACCOUNTS_PUBLIC_URL` | yes | Externally stable HTTPS broker URL used for OIDC redirects |
| `SULLA_ACCOUNTS_ALLOWED_RETURN_ORIGINS` | no | Comma-separated exact HTTPS origins; loopback HTTP is allowed for local development |
| `SULLA_ACCOUNTS_SERVICE_TOKENS_FILE` | private API | `0600` JSON map of service ids to `{token, issuers, allowedAudiences, pathPrefixes, methods}` grants; methods are limited to `GET`/`POST` |
| `SULLA_ACCOUNTS_TRUSTED_PROXY` | no | `1` only behind the packaged reverse proxy |

Secrets are read at startup. Environment variables may name secret files but must not contain
the secret value. Startup fails closed for missing, group/world-readable, short, or malformed
secret files. Accounts performs discovery against the joined authority's external issuer.

## HTTP authentication

- `GET /healthz` is liveness only. It never touches storage or returns configuration.
- `GET /readyz` returns `200` only after database migration and a database round trip.
- Owner routes require `Authorization: Bearer <broker-session>`. Broker sessions have audience
  `sulla-accounts`, issuer equal to `SULLA_ACCOUNTS_PUBLIC_URL`, a random session id, and a
  maximum lifetime of 15 minutes.
- `POST /v1/private/bootstrap/session` requires the bootstrap
  file value as a bearer token. It is the
  only owner-session acquisition endpoint: it creates the stable local profile only when absent,
  then mints a short-lived session on first run and later app restarts. The packaged desktop
  control process reads the protected file and keeps the value out of renderer/UI/model scope.
  There is no unauthenticated owner mint, loopback trust, default credential, or query-string
  credential.
- Internal authorization checks use `POST /v1/private/resolve-context` with both
  `X-Sulla-Service-Id` and that service's credential in `X-Sulla-Service-Token`. Credentials
  come from `SULLA_ACCOUNTS_SERVICE_TOKENS_FILE`; this endpoint never returns OIDC tokens and a
  service credential alone grants no access to an owner's stored authority session. Every
  service grant has an explicit `allowedAudiences` list; Accounts rejects a requested target
  audience that is absent even when the issuer is otherwise allowed.
- Remote consumers use the same scoped service identity with
  `POST /v1/private/authorities/:id/fetch`. Accounts refreshes its own authority access token
  internally, then performs a bounded same-origin request. The call must also carry the local
  owner's current broker session in `X-Sulla-Owner-Authorization`; a service credential alone
  cannot use the owner's authority session. The caller supplies an organization id, required
  roles, an allowed method, a relative path, and optional JSON body. Accounts confirms the
  stored issuer+subject's fresh remote membership before the outbound call. The configured
  grant must include the authority issuer, method, and a matching path prefix. No access token,
  refresh token, cookie, redirect, or arbitrary response header crosses the broker boundary.
  After verification, Accounts forwards `X-Sulla-Authority-Id` using the authority's stable
  remote UUID and `X-Sulla-Organization-Id` using the exact verified organization UUID.

## Versioned owner API

| Method and path | Result |
| --- | --- |
| `POST /v1/private/bootstrap/session` | Authenticated bootstrap; returns `{token, expiresAt, profile}` |
| `POST /v1/sessions/refresh` | Rotates the current short-lived broker session |
| `GET /v1/profile` | Local profile (id, display name, created/updated timestamps) |
| `PATCH /v1/profile` | Changes local display name only |
| `GET /v1/connections` | Sanitized authority registry; never tokens or authorization secrets |
| `POST /v1/connections` | Pins an explicit issuer, client id, resource-audience list, scopes, and optional membership endpoint plus its `remoteAuthorityId` and `membershipAudience`, verified against authority metadata |
| `DELETE /v1/connections/:id` | Revokes locally if possible, then deletes encrypted session and connection |
| `POST /v1/connections/:id/authorize` | Creates PKCE S256 transaction for one allowed `resourceAudience` and returns `{authorizationUrl, expiresAt}` |
| `GET /v1/oidc/callback?code=…&state=…` | Strict one-use state callback; exchanges code and stores encrypted tokens |
| `GET /v1/memberships` | Hints only for subjects on this owner's connected authority sessions; never a hosted member directory |

Connection creation is the explicit trust-enrollment action and performs OIDC discovery with an
exact canonical URL issuer match (path slashes are not stripped). Self-hosted LAN issuers are supported over HTTPS. Loopback HTTP is
permitted for local development only. Userinfo, token, JWKS, revocation, and membership URLs must
have the same origin as the pinned issuer; redirects and cross-origin credential forwarding are
refused.
Discovery and token calls reject redirects, use bounded response sizes and timeouts, and never
fall back to email matching.

Each connection has an installation-local `id` used to address its encrypted session and a
distinct `remoteAuthorityId` advertised by the hosted authority. The two UUIDs must never be
substituted: local APIs select the connection by `id`; outbound domain-service context uses
`remoteAuthorityId`.

The connection response labels these records as `type: "oidc"` and includes a separate
`legacyCloudConnections` metadata collection. Legacy Sulla Cloud connection metadata is not
treated as an OIDC authority, cannot gain an Accounts session, and is never silently linked or
upgraded by email.

Authorization transactions expire after five minutes. Accounts stores only a SHA-256 state
digest plus the encrypted PKCE verifier. The callback consumes the transaction before token
exchange, requires the discovered issuer to remain pinned, verifies ID-token signature,
`iss`, `aud`, `exp`, nonce, and non-empty `sub`, and records the identity tuple.

## Private authorization contract

Service UI tokens issued by a joined org server are resolved with `POST /v1/private/ui-sessions/resolve` using the same service headers; Desktop never issues them.

`POST /v1/private/resolve-context` accepts:

```json
{
  "bearerToken": "request token",
  "authorityId": "pinned connection UUID",
  "audience": "target service audience",
  "organizationId": "required organization UUID",
  "requiredRoles": ["member"]
}
```

It returns `{issuer, subject, authorityId, organizationId, roles, groups, audience}` only after token
signature/issuer/audience/expiry validation and a current membership check. For a remote
connection, Accounts calls its explicit membership endpoint on every resolution using the
validated caller bearer token, never the local owner's stored session. The live response must
repeat the exact validated issuer+subject and requested organization. A timeout, issuer mismatch,
missing organization, or revoked membership returns `403`; cached rows are not authorization
evidence. The
returned `audience` is the exact requested and verified target audience so every consumer can
compare the full context tuple.

## Renewable delegated schedule grants

Workflow schedules never persist a user bearer or send runner tokens to Accounts. The workflow
manager persists only the opaque grant returned by Accounts and treats it as a secret.

Grants are issued by the joined org server's Accounts (`merchantprotocol/sulla-server`); Desktop only resolves and revokes them.

At every scheduled fire, catch-up, delayed continuation, and wait resume, the workflow manager
calls `POST /v1/private/schedule-grants/resolve` with its normal
`X-Sulla-Service-Id` / `X-Sulla-Service-Token` headers and body
`{ "grantToken": "opaque secret" }`. Accounts requires the calling service to match the grant,
then rechecks the current membership and bound roles. Memberships use Accounts' encrypted renewable authority session,
whose exact subject must match the grant. Success returns exactly
`{issuer, subject, authorityId, organizationId, roles, groups, audience, workflowId, scheduleNodeId, expiresAt}`.
Revocation, expiry, missing roles, membership failure, session-subject mismatch, or service or
audience mismatch is `403` and the workflow must not run.

On schedule deletion or ownership or scope change, the manager calls
`POST /v1/private/schedule-grants/revoke` with service headers and
`{ "grantToken": "opaque secret" }`. It is idempotent and returns `204`; it can revoke only a
grant bound to that calling service. Accounts never accepts workflow runner tokens as user
bearers or delegated grant tokens.

## PostgreSQL storage

The Accounts migrations create an `accounts` schema with:

- `local_profile`: exactly one installation-local owner profile.
- `authorities`: local connection UUID, distinct remote authority UUID, issuer pin, client
  metadata, discovery endpoints, trust policy, and timestamps.
- `authority_sessions`: encrypted access/refresh/id token envelopes and expiry metadata, keyed
  by authority; ciphertext, nonce, and authentication tag are stored separately.
- `authorization_transactions`: state digest, encrypted verifier, nonce, redirect URI, expiry,
  and one-use consumption timestamp.
- `memberships`: legacy local Sulla memberships keyed by `(issuer, subject,
  organization_id)` with roles/groups and revocation timestamp.
- `membership_cache`: remote display hints with source timestamp and expiry; never consulted as
  authorization evidence. Each row carries the verified subject and owner views filter it against
  the connection subject, so another caller cannot pollute the owner's hints.
- `broker_sessions`: hashed session ids supporting rotation/revocation without storing bearer
  tokens.
- `delegated_schedule_grants`: digested opaque grant tokens bound to issuer, subject, authority,
  organization, target audience, service, workflow, schedule node, required roles, expiry, and
  revocation state.
- `accounts_schema_migrations`: append-only migration ledger.

Encryption uses AES-256-GCM with a fresh 96-bit nonce and authenticated context containing the
table, row id, authority id, and envelope version. This delivery introduces version `1` only;
it does not migrate or reinterpret any existing Vault, Files, wallet, or user-data format.

## Rollback

Stop the Accounts process, restore the previous container image, and leave the `accounts`
schema in place. No existing service schema or personal ownership record is modified. Removing
the new schema is a separate destructive database operation and is not part of runtime rollback.

Authorization callbacks verify the access-token issuer, selected resource audience, expiry,
and subject equality with the verified ID token before persisting the session. The selected
audience is pinned in the authorization transaction; pre-upgrade in-flight transactions
without this pin must restart sign-in.
