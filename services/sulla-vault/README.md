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

Run the existing Desktop compose file and the vault overlay together from the repository root. The overlay has no default database password: export `SULLA_SERVICE_PASSWORD` first (compose refuses to start without it).

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

## Bounded synthetic broker load harness

`scripts/load/test-load.ts` runs a disposable local vault API over a fresh PGlite directory and a
generated self-signed TLS certificate. Its only provider endpoint is an HTTPS synthetic upstream
bound to `127.0.0.1`; the test-only composition injects an `UpstreamHttpClient` subclass that permits
only the generated `https://api.openai.com:<ephemeral-port>` origin and trusts the run's generated
CA. That exception is not an environment/config switch: production composition still constructs the
default `UpstreamHttpClient`, `ValidatedUpstreamResolver`, address policy, DNS lookup, and system CA
path. Outbound requests still use the real `https.request`/TLS-pin path. Stream requests use the
real `DesktopVaultTransport.fetchStream` Node/undici path; an Electron session stub throws if used.
The vault binds only to test port `40135` and does not contact the real vault, a real provider, or
the installed vault container/data.

Run from the repository root when the repo/vault dependencies and `openssl` are already available:

```sh
services/sulla-vault/node_modules/.bin/tsx \
  --tsconfig services/sulla-vault/scripts/load/tsconfig.load.json \
  services/sulla-vault/scripts/load/test-load.ts
```

Defaults: 300 concurrent streams, 30-second upstream hold, 350 KB (350,000 byte) synthetic JSON
provider body, 100 cancellations, then a recovery wave. It refuses to start below 4 GiB
`MemAvailable`, caps concurrency/cancellations at 1,000, and prints one secret-free JSON summary.
The summary includes upstream maximum concurrency, p50/p95 headers against a single-call baseline,
credential lookup / buffered broker execute / health p50/p95 and failures while streams are open,
request-received-to-upstream-TLS-connect delay, 1-second vault RSS/heap and client RSS/CPU samples,
heap-OOM detection, and before/after file-descriptor/socket counts. `--duration 300` enables the
five-minute resource soak; the default run is under three minutes.

Flags: `--concurrency N` (default 300, range 1–1,000), `--hold-seconds N` (30, range 1–300),
`--body-kb N` (350, range 1–1,024; decimal KB, with a 128 MiB combined in-flight body budget), `--duration N` (0 by default, range 0–300;
`--duration 300` is the five-minute soak), and `--cancel N` (100, range 0–1,000; `--cancel 0`
disables cancellation). A bare `--cancel` also selects 100.

The test child uses `NODE_OPTIONS="--max-old-space-size=256 --max-semi-space-size=2"` and reports
heap use and RSS against the Desktop-generated Compose `mem_limit: 768m`. `pkg/sulla-desktop/backend/sullaRuntimeBackend.ts`
sets those Node flags and the 768 MiB container limit; the packaged `services/sulla-vault/Dockerfile`
uses Node 24 and `UV_THREADPOOL_SIZE=16`. The test process mirrors the flags but runs under the host
Node runtime and does not run in a 768 MiB cgroup, so RSS is observed against (not enforced by) that
limit. Its test resolver performs local `localhost` DNS only and
pins IPv4 loopback, never resolving or connecting to a provider hostname. The production code
configures a PostgreSQL pool with max 10; this disposable API uses the service's PGlite test strategy
(no `pg.Pool`), so receive-to-connect timing measures request parsing, test DB lookup, local resolver
and TLS connect but cannot isolate the production pool.
