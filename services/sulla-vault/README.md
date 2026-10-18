# Sulla Vault service

`sulla-vault` stores encrypted vault records in its own `sulla_vault` database. It does not read or migrate Desktop's `sulla` database, `integration_values`, `VaultKeyService`, or any existing vault tool. The client sends a login hash for authentication and ciphertext for storage. It never sends the master key, user key, item key, or plaintext item.

## Key hierarchy

```text
master password
    |
    +-- Argon2id --> master key (client memory only)
                         |
                         +-- XChaCha20-Poly1305 --> random user key
                                                          |
                                                          +-- item key --> item ciphertext
                                                          |
                                                          +-- X25519 private key

organization key --X25519 sealed box--> each member public key
       |
       +-- XChaCha20-Poly1305 --> collection key --> shared item keys

agent-enabled item key --X25519 sealed box--> server agent public key
```

The login hash is a separate keyed BLAKE2b derivation of the master key. The service applies scrypt and a per-account salt before storing its verifier, so the database does not contain the replayable login hash. XChaCha20-Poly1305 item envelopes bind the client-generated item ID and cryptographic owner ID as additional authenticated data. Use the user ID for a personal item and the collection ID for a shared item; this prevents a stored envelope from being moved to another item or owner.

## Run in Desktop mode

Desktop mode has one bootstrapped user and deliberately returns 404 from `POST /v1/accounts`. Generate the master key, login hash, random user key, and X25519 keypair with `@sulla/vault-crypto`, then pass the public and encrypted values through the `SULLA_VAULT_DESKTOP_*` variables shown in `compose.snippet.yaml`.

The Desktop integration is flag-off by default and currently builds this service from the source checkout. A published `sulla-vault` image is required before the flag can ship in packaged apps; image publishing is not configured yet.

Run the existing Desktop compose file and the vault overlay together from the repository root:

```sh
docker compose \
  --project-directory . \
  -f pkg/rancher-desktop/assets/sulla-docker-compose.yaml \
  -f services/sulla-vault/compose.snippet.yaml \
  up -d postgres sulla_vault
```

The service creates only the `sulla_vault` database through the admin connection, runs its migrations there, and listens on `127.0.0.1:30135`.

## Run in server mode

Set `SULLA_VAULT_MODE=server`, use PostgreSQL URLs for the server deployment, and set a random `SULLA_VAULT_JWT_SECRET` of at least 32 characters. Server mode enables account registration and applies authenticated ownership or organization/collection rights to every `/v1` data route. TLS belongs at the server ingress; do not expose the container's HTTP port directly.

Accounts authorization is optional and fail-closed. Configure all of `SULLA_VAULT_ACCOUNTS_URL`,
`SULLA_VAULT_ACCOUNTS_SERVICE_ID`, and `SULLA_VAULT_ACCOUNTS_SERVICE_TOKEN_FILE`; the token file
must be a regular `0600` file with at least 32 bytes. The audience is fixed to `sulla-vault`, and
`SULLA_VAULT_ACCOUNTS_REQUIRED_ROLES` defaults to `member`.

Linking is an explicit two-session operation. An existing confirmed Vault organization member authenticates
with the normal Vault bearer, supplies the verified Accounts bearer separately in
`X-Sulla-Accounts-Authorization`, and supplies the enrolled authority UUID in
`X-Sulla-Accounts-Authority-Id` to `POST /v1/orgs/:orgId/accounts-identities`. Vault records only the
verified `(issuer, subject)` tuple against the existing Vault user UUID; it never links by email.
List and unlink operations manage only the authenticated member's own links with `GET` and `DELETE`.

After linking, an Accounts request carries its bearer in `Authorization` plus exact
`X-Sulla-Authority-Id` and `X-Sulla-Organization-Id` headers. Vault resolves fresh Accounts
membership for the `sulla-vault` audience, maps the returned issuer and subject to the explicit
link, confirms the existing Vault membership, derives the owning organization for every
collection/item/group operation, and rejects mismatches. Accounts authentication does not unlock
Vault, return encryption keys, create personal resources, change account credentials, or bypass
the existing organization and collection RBAC checks. If Accounts configuration is absent or
partial, Accounts-authenticated paths are denied.

## API

All request and response key material described as encrypted is an opaque JSON envelope. Every route below requires a bearer token except health, account creation, and login.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | Database and mode health |
| `POST` | `/v1/accounts` | Create a server-mode account from a login hash and wrapped keys |
| `POST` | `/v1/session` | Verify a login hash and return wrapped account keys plus a token |
| `GET`, `POST` | `/v1/items` | List authorized ciphertext items or create one with a client-generated UUID |
| `GET`, `PATCH`, `DELETE` | `/v1/items/:itemId` | Read, revision-update, or soft-delete an item |
| `GET`, `POST` | `/v1/folders` | List or create personal encrypted folders |
| `PATCH`, `DELETE` | `/v1/folders/:folderId` | Revision-update or delete a personal folder |
| `GET`, `POST` | `/v1/orgs` | List memberships or create an organization and owner membership |
| `GET`, `POST`, `DELETE` | `/v1/orgs/:orgId/accounts-identities` | Explicitly list, link, or unlink a verified Accounts identity for the authenticated confirmed Vault member |
| `PATCH` | `/v1/orgs/:orgId` | Update an encrypted organization name |
| `GET`, `POST`, `DELETE` | `/v1/orgs/:orgId/members[/:memberId]` | List, add/update, or remove members |
| `GET`, `POST` | `/v1/orgs/:orgId/collections` | List authorized collections or create one |
| `PATCH` | `/v1/collections/:collectionId` | Update collection ciphertext and wrapped key |
| `GET` | `/v1/collections/:collectionId/items` | Read collection ciphertext with `view` rights |
| `PUT`, `DELETE` | `/v1/collections/:collectionId/members/:memberId` | Set or remove `view`, `useByAgents`, `edit`, and `manage` rights |
| `POST` | `/v1/audit` | Append an immutable audit event; agent use checks agent rights first |

Item updates use optimistic revision checks. The audit table rejects updates and deletes at the database layer. Organization owners and admins can manage every collection; ordinary members receive only the four explicit collection rights stored for them.
