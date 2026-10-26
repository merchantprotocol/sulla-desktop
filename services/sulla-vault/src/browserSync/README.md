# Vault origin backend (server mode)

In server mode, Vault serves the Passwords page on its own hostname, `vault.<host>`, and answers
`/cloud-vault-sync/*`, the API Sulla Cloud's Passwords page already speaks. The page, its crypto
worker and the sync envelope are Cloud's (`www-sulladesktop js/cloud/passwords`, built into
`services/sulla-vault/browser-dist` by WP-A). This folder is the server half.

The server never sees a password, a key or a decrypted item. Every request body and every row
written here is ciphertext, a MAC, a hash, a counter or an id.

## The model: one org vault

- Each Vault organization has one **org vault** (`browser_sync_vaults`). Its id is the `vaultId`
  every sync envelope is bound to.
- Each member has their own **bundle** (`browser_sync_bundles`): their wrapped user key, key pair
  and Argon2id parameters, MAC'd by their browser. The server only accepts a bundle whose fields
  equal the wrapped keys already stored on the member's Vault account, so a browser can't swap in
  other keys. After a password change, the stale bundle is refused (`bundle_stale`) until the
  browser rewraps it.
- **Scopes**: `personal` (one per member, keyed by their user id) and one per shared **collection**
  (keyed by the collection id). Records (`browser_sync_records`) are item ciphertext or tombstones;
  each scope has a signed head (`browser_sync_heads`).
- `GET /vaults/:id/bundle?include=collections` adds the member's sealed org key and the wrapped
  key of every collection they can read, so a client can open shared scopes. Collections they
  can't read are never listed, and their records are 404.
- A collection scope needs the collection's `view` right to read and `edit` to write (direct or
  through a group; org owners and admins have both). Rights are checked from Vault's own tables
  on every request.

## Routes

| Method | Path | Caller | Purpose |
| --- | --- | --- | --- |
| `GET` | `/cloud-vault-sync/status` | Console API (bearer) or vault cookie | Metadata only. `enabled:false` comes with `setup: 'enroll'` or `'rewrap'` |
| `POST` | `/cloud-vault-sync/browser/handoff` | Console API (bearer) | One-time code (60 s, single use, stored hashed). Optional body `organizationName` for display |
| `POST` | `/cloud-vault-sync/browser/session` | vault page | Code → `__Host-sulla_vault` cookie (HttpOnly, Secure, SameSite=Strict, 12 h) |
| `GET`, `DELETE` | `/cloud-vault-sync/browser/session` | vault page | Who is signed in / sign out |
| `GET` | `/cloud-vault-sync/browser/devices` | vault page | The member's enrolled devices |
| `GET` | `/cloud-vault-sync/audit` | either | Metadata-only events from `audit_log`. Members see their own; owners and admins see everyone's |
| `GET` | `/cloud-vault-sync/vaults/:id/enrollment` | vault page | The unsigned bundle fields to MAC on first unlock (or after a password change) |
| `PUT` | `/cloud-vault-sync/vaults/:id?op=create\|rewrap` | vault page | Store the member's MAC'd bundle (create also takes the personal scope's first head) |
| `GET` | `/cloud-vault-sync/vaults/:id/bundle` | vault page | The member's bundle |
| `GET` | `/cloud-vault-sync/vaults/:id/records?scope=` | vault page | Paged records + head for `personal` or a collection id |
| `POST` | `/cloud-vault-sync/vaults/:id/commit` | vault page | Compare-and-swap writes for one scope |

Bearer callers are the Console API with the user's Accounts UI-session token (audience
`sulla-vault`), resolved through `/v1/private/ui-sessions/resolve` and the explicit
`accounts_identities` link, exactly like `/v1`. Without Accounts configured, a Vault session token
plus `X-Sulla-Organization-Id` works the same way. A bearer can only read status and audit and mint
handoffs; ciphertext only goes to the vault page.

Cookie requests must arrive on the vault hostname, from the vault `Origin` (or
`Sec-Fetch-Site: same-origin`), with `X-Sulla-Vault-Request: 1`. Membership is re-checked on every
request, so removing someone from the organization ends their vault session.

On `vault.<host>`, Vault serves only `browser-dist` (with Cloud's vault-origin CSP, `no-store` and
the other `_headers` values) and `/cloud-vault-sync/*`. Every other Vault route is 404 there, and
the page is 404 on every other hostname. Console screens the page links to redirect back to the
console. `passwords.html` may carry `__SULLA_DASHBOARD_ORIGIN__`; Vault fills in the console URL
when it serves the page.

Cloud features with no server equivalent yet answer 404: the emailed step-up and deleting the vault
copy (`/browser/stepup/*`, `DELETE /vaults/:id`).

## server-providers

Model provider keys for server agents (`/v1/server-providers/*`, org owners and admins). A key is
sealed (X25519 sealed box) to the Agents broker's public key before it reaches Vault, so Vault stores
ciphertext it can't open. `GET /v1/server-providers/recipient` returns the public key and fingerprint
to seal to; a `PUT` sealed to any other key is refused. Agents fetch the sealed key at run start with
`POST /v1/broker/server-providers/credential` (service identity, body `{ organizationId, provider,
claims: { agent_id, pod_id, sub? } }`) and open it in memory with their private key. Every write and
every fetch is audited. Non-secret settings (models, defaults, a display hint) belong in the console's
own database, not here.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `SULLA_PUBLIC_URL` | none | `https://<host>`. Derives `vault.<host>` and the console URL `https://<host>/console/` |
| `SULLA_VAULT_BROWSER_HOST` | `vault.<host>` | The vault page's hostname. Empty disables the vault origin (cookie routes and page 404) |
| `SULLA_VAULT_BROWSER_ORIGIN` | `https://<vault host>` | The exact allowed `Origin`, for a non-default port |
| `SULLA_VAULT_DASHBOARD_URL` | `https://<host>/console/` | Where the page's console links go |
| `SULLA_VAULT_BROWSER_DIST` | `../browser-dist` | WP-A's built vault origin |
| `SULLA_VAULT_PROVIDERS_RECIPIENT_PUBLIC_KEY` | none | Agents broker X25519 public key (base64url) |
| `SULLA_VAULT_PROVIDERS_SERVICE_ID` | `sulla-agents` | Service id allowed to fetch sealed provider keys |
| `SULLA_VAULT_PROVIDERS_SERVICE_TOKEN_FILE` | none | `0600` file, at least 32 bytes |

The gateway must pass the original `Host` header through to Vault for `vault.<host>`.

## Test

`browserSync.security.test.ts` needs a disposable Postgres in `SULLA_VAULT_TEST_DATABASE_URL`:
the browser KAT (`../browserEnvelope/vault-sync-v3-kat.json`) round-trips through these routes and
still verifies and decrypts, with no plaintext in Postgres; and a member without a collection's
`view` right never receives its records.
