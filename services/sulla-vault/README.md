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
  -f pkg/sulla-desktop/assets/sulla-docker-compose.yaml \
  -f services/sulla-vault/compose.snippet.yaml \
  up -d postgres sulla_vault
```

The service creates only the `sulla_vault` database through the admin connection, runs its migrations there, and listens on `127.0.0.1:30135`.

## Server mode moved to Sulla Server

This service runs only in Desktop mode. `loadConfig()` accepts `SULLA_VAULT_MODE=desktop` (the
default) and refuses anything else. The hosted vault (account registration, organizations and
collections over `/v1`, Accounts-backed identity, the bootstrap CLI, the org console under `/ui`, and
the `vault.<host>` browser sync origin) lives in `merchantprotocol/sulla-server`.

The migration files for those hosted tables (`004`–`008`, `012`, `015`, `016`) stay here on purpose:
installed Desktops have already recorded them, and removing them would break the migration chain.

## API

The Desktop API is the local authority contract in [`LOCAL_DESKTOP_AUTHORITY.md`](LOCAL_DESKTOP_AUTHORITY.md):
`/healthz`, the `/v1/desktop/*`, `/v1/human/*`, `/v1/broker/*` and cloud-sync routes registered in
`src/app.ts`, and the local vault UI under `/vault/`. Any other `/v1` path returns 404.
