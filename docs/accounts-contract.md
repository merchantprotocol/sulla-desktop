# Sulla Accounts service contract

Sulla Accounts is the identity broker for one Sulla installation. The broker runs in both
`desktop` and `server` modes on port `3020`. In server mode, the same container may also run
Keycloak on loopback port `8080`; Keycloak is not a required sidecar and is never started in
desktop mode.

## Ownership and trust boundaries

- Accounts owns the installation-local profile, the per-owner authority/connection registry,
  encrypted OIDC sessions, and Sulla organization memberships/roles/groups.
- Accounts stores only its own Sulla-authority OIDC sessions. Third-party provider/integration
  refresh tokens and all provider decryption material remain Vault-owned; Accounts is not a
  generic integration secret store and does not migrate secrets out of Vault.
- Keycloak owns hosted credentials, authentication ceremonies, and its own login sessions.
- A person is identified only by the tuple `(canonically serialized trusted issuer, stable subject)`. Email,
  display name, and username are attributes and never link identities.
- The local owner remains the owner of personal resources after server mode is enabled. Domain
  services continue to enforce their own resource ACLs and encryption.
- Owner APIs cannot administer organization memberships. Admin APIs cannot read the local
  profile, connections, authorization transactions, or encrypted sessions.
- Access and refresh tokens are encrypted at rest and are never returned by an API, written to
  logs, or included in model/tool-visible connection responses.
- Cached memberships are display hints only. A request requiring remote membership calls the
  trusted authority's configured membership endpoint; failure or revocation denies access.

## Process configuration

| Variable | Required | Contract |
| --- | --- | --- |
| `SULLA_ACCOUNTS_MODE` | no | `desktop` (default) or `server` |
| `SULLA_ACCOUNTS_PORT` | no | Broker port; default `3020` |
| `SULLA_ACCOUNTS_DATABASE_URL_FILE` | yes | `0600` file containing the PostgreSQL URL for the Accounts-owned database; the URL is never accepted directly in the environment |
| `SULLA_ACCOUNTS_BOOTSTRAP_SECRET_FILE` | desktop | `0600` regular file used only to mint the local Desktop owner session; forbidden and unread in server mode |
| `SULLA_ACCOUNTS_SESSION_SECRET_FILE` | yes | `0600` file containing at least 32 bytes for short-lived broker JWTs |
| `SULLA_ACCOUNTS_ENCRYPTION_KEY_FILE` | yes | `0600` file containing exactly 32 raw bytes or 64 hexadecimal characters for AES-256-GCM |
| `SULLA_ACCOUNTS_PUBLIC_URL` | yes | Externally stable HTTPS broker URL used for OIDC redirects |
| `SULLA_ACCOUNTS_ALLOWED_RETURN_ORIGINS` | no | Comma-separated exact HTTPS origins; loopback HTTP is allowed in desktop mode |
| `SULLA_ACCOUNTS_ADMIN_SECRET_FILE` | server | Separate `0600` secret for private membership administration |
| `SULLA_ACCOUNTS_SERVICE_TOKENS_FILE` | private API | `0600` JSON map of service ids to `{token, issuers, allowedAudiences, pathPrefixes, methods}` grants; methods are limited to `GET`/`POST` |
| `SULLA_ACCOUNTS_KEYCLOAK_ISSUER` | server | Stable external issuer, normally `${PUBLIC_URL}/auth/realms/sulla`; never the internal port |
| `SULLA_ACCOUNTS_KEYCLOAK_NATIVE_CLIENT_ID` | server | Public PKCE client advertised to Desktop; stable value `sulla-desktop` |
| `SULLA_ACCOUNTS_KEYCLOAK_WEB_CLIENT_ID` | server | Separate confidential hosted web client; stable value `sulla-web` |
| `SULLA_ACCOUNTS_KEYCLOAK_MEMBERSHIP_AUDIENCE` | server | Dedicated audience required by the public membership resolver; stable value `sulla-membership` |
| `SULLA_ACCOUNTS_KEYCLOAK_RESOURCE_AUDIENCES` | server | Comma-separated target audiences minted by Keycloak and accepted only when explicitly granted to a service |
| `SULLA_ACCOUNTS_TRUSTED_PROXY` | no | `1` only behind the packaged reverse proxy |

Secrets are read at startup. Environment variables may name secret files but must not contain
the secret value. Startup fails closed for missing, group/world-readable, short, or malformed
secret files. The reverse proxy publishes the stable Keycloak issuer path and forwards it to
`127.0.0.1:8080`; Accounts performs discovery against the external issuer.

## HTTP authentication

- `GET /healthz` is liveness only. It never touches storage or returns configuration.
- `GET /readyz` returns `200` only after database migration and a database round trip.
- Owner routes require `Authorization: Bearer <broker-session>`. Broker sessions have audience
  `sulla-accounts`, issuer equal to `SULLA_ACCOUNTS_PUBLIC_URL`, a random session id, and a
  maximum lifetime of 15 minutes.
- `POST /v1/private/bootstrap/session` exists only in `desktop` mode and requires the bootstrap
  file value as a bearer token. It is the
  only owner-session acquisition endpoint: it creates the stable local profile only when absent,
  then mints a short-lived session on first run and later app restarts. The packaged desktop
  control process reads the protected file and keeps the value out of renderer/UI/model scope.
  There is no unauthenticated owner mint, loopback trust, default credential, or query-string
  credential. Server mode does not register this route and never reads or stages a Desktop
  bootstrap secret.
- `/v1/admin/**` is available only in server mode and requires the distinct admin file value as
  a bearer token. It never accepts an owner session.
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

## Versioned owner API

| Method and path | Result |
| --- | --- |
| `POST /v1/private/bootstrap/session` | Desktop-only authenticated bootstrap; returns `{token, expiresAt, profile}` |
| `POST /v1/sessions/refresh` | Rotates the current short-lived broker session |
| `GET /v1/profile` | Local profile (id, display name, created/updated timestamps) |
| `PATCH /v1/profile` | Changes local display name only |
| `GET /v1/connections` | Sanitized authority registry; never tokens or authorization secrets |
| `POST /v1/connections` | Pins an explicit issuer, client id, resource-audience list, scopes, and optional membership endpoint |
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

The connection response labels these records as `type: "oidc"` and includes a separate
`legacyCloudConnections` metadata collection. Legacy Sulla Cloud connection metadata is not
treated as an OIDC authority, cannot gain an Accounts session, and is never silently linked or
upgraded by email.

Authorization transactions expire after five minutes. Accounts stores only a SHA-256 state
digest plus the encrypted PKCE verifier. The callback consumes the transaction before token
exchange, requires the discovered issuer to remain pinned, verifies ID-token signature,
`iss`, `aud`, `exp`, nonce, and non-empty `sub`, and records the identity tuple.

## Hosted authority discovery and membership

Server mode publishes `GET /.well-known/sulla-authority` from the same origin as the hosted
issuer. Its stable response is:

```json
{
  "issuer": "https://accounts.example/auth/realms/sulla",
  "nativeClientId": "sulla-desktop",
  "nativeRedirectUris": ["http://127.0.0.1:3020/v1/oidc/callback"],
  "scopes": ["openid", "profile"],
  "membershipAudience": "sulla-membership",
  "resourceAudiences": ["sulla-projects", "sulla-files", "sulla-vault", "sulla-workflows"],
  "membershipResolver": "https://accounts.example/v1/authority/membership/resolve"
}
```

The packaged realm has two distinct clients: public native client `sulla-desktop`, requiring
authorization-code plus PKCE S256 and allowing only the Desktop loopback callback above; and
confidential hosted client `sulla-web`, whose redirects are separately deployment-configured.
The packaged Desktop integration must bind or forward host loopback port `3020` to the Accounts
listener before launching the system browser; Lima reachability is not assumed by this contract.
The base login token carries only the explicit `sulla-membership` audience. Each resource
audience is attached to a separate optional client scope named `sulla-audience:<audience>`;
clients request only the scope needed for that operation. No client receives every resource
audience by default. Client ids, issuer ids, and resource audiences are never interchangeable.

`POST /v1/authority/membership/resolve` is public in the network sense and requires
`Authorization: Bearer <hosted-access-token>`; it accepts `{ "organizationId": "uuid" }`.
Accounts verifies the JWT signature using the hosted JWKS, exact configured issuer, `exp`,
non-empty `sub`, and exact `sulla-membership` audience. It derives the subject only from the
JWT, queries exactly `(issuer, subject, organizationId)`, and returns
`{issuer, subject, organizationId, roles, groups}` only for that active membership. It never
accepts subject in input and never lists memberships. Invalid or missing JWTs are `401`, a valid
identity without that active membership is `403`, and malformed input is `400`.

## Private authorization contract

`POST /v1/private/resolve-context` accepts:

```json
{
  "bearerToken": "request token",
  "authorityId": "pinned connection UUID or local hosted authority",
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
evidence. For the local hosted authority, the Accounts membership table is authoritative. The
returned `audience` is the exact requested and verified target audience so every consumer can
compare the full context tuple.

## Renewable delegated schedule grants

Workflow schedules never persist a user bearer or send runner tokens to Accounts. The workflow
manager persists only the opaque grant returned by Accounts and treats it as a secret.

`POST /v1/private/schedule-grants/issue` requires the workflow manager's normal
`X-Sulla-Service-Id` / `X-Sulla-Service-Token` headers. It accepts the current user token only
over that trusted service transport and never exposes the returned grant through renderer,
tool, model, or log output:

```json
{
  "authorityId": "uuid",
  "organizationId": "uuid",
  "audience": "sulla-workflows",
  "serviceId": "workflows",
  "workflowId": "stable workflow id",
  "scheduleNodeId": "stable schedule node id",
  "requiredRoles": ["member"],
  "expiresAt": "RFC3339 timestamp, at most 90 days",
  "replaceGrantId": "optional existing grant uuid",
  "bearerToken": "current user access token, never persisted"
}
```

Accounts verifies the bearer for the exact issuer and target audience, derives its subject,
checks that the authenticated service grant permits the issuer and audience, and confirms fresh
active membership plus all required roles. `replaceGrantId`, when present, must belong to the
same derived identity, service, authority, organization, audience, workflow, and schedule node;
the old grant is revoked in the same transaction. Success returns
`{grantId, grantToken, expiresAt}`. `grantToken` is 256 bits of randomness returned once;
Accounts stores only its SHA-256 digest. This is the sole delegated-authorization secret returned
by Accounts and is available only to an authenticated service, never a browser caller. Renewal is an authenticated replacement before expiry,
not silent extension. Expired grants fail closed and remain unusable.

At every scheduled fire, catch-up, delayed continuation, and wait resume, the workflow manager
calls `POST /v1/private/schedule-grants/resolve` with its normal
`X-Sulla-Service-Id` / `X-Sulla-Service-Token` headers and body
`{ "grantToken": "opaque secret" }`. Accounts requires the calling service to match the grant,
then rechecks the current membership and bound roles. Hosted memberships are read from the
authoritative table; remote memberships use Accounts' encrypted renewable authority session,
whose exact subject must match the grant. Success returns exactly
`{issuer, subject, authorityId, organizationId, roles, groups, audience, workflowId, scheduleNodeId, expiresAt}`.
Revocation, expiry, missing roles, membership failure, session-subject mismatch, or service or
audience mismatch is `403` and the workflow must not run.

On schedule deletion or ownership or scope change, the manager calls
`POST /v1/private/schedule-grants/revoke` with service headers and
`{ "grantToken": "opaque secret" }`. It is idempotent and returns `204`; it can revoke only a
grant bound to that calling service. Accounts never accepts workflow runner tokens as user
bearers or delegated grant tokens.

## Private admin API

| Method and path | Result |
| --- | --- |
| `GET /v1/admin/memberships?organizationId=…` | Membership metadata; no local profile/connections/sessions |
| `PUT /v1/admin/memberships/:id` | Creates/replaces `(issuer, subject, organization)` roles and groups |
| `DELETE /v1/admin/memberships/:id` | Revokes the membership immediately |

Admin writes require UUID organization/membership identifiers, an issuer already enrolled in the
trusted authority registry,
a non-empty stable subject, and arrays of bounded role/group strings. Revocation deletes the
authoritative row; no cache can restore it.

## PostgreSQL storage

The Accounts migrations create an `accounts` schema with:

- `local_profile`: exactly one installation-local owner profile.
- `authorities`: issuer pin, client metadata, discovery endpoints, trust policy, and timestamps.
- `authority_sessions`: encrypted access/refresh/id token envelopes and expiry metadata, keyed
  by authority; ciphertext, nonce, and authentication tag are stored separately.
- `authorization_transactions`: state digest, encrypted verifier, nonce, redirect URI, expiry,
  and one-use consumption timestamp.
- `memberships`: authoritative local Sulla memberships keyed by `(issuer, subject,
  organization_id)` with roles/groups and revocation timestamp.
- `membership_cache`: remote display hints with source timestamp and expiry; never consulted as
  authorization evidence.
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
