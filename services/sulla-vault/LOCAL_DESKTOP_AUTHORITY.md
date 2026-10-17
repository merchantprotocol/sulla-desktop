# Local Desktop vault authority

Status: implementation contract for `feat/vault-container-authority`.

This contract applies only when `SULLA_VAULT_MODE=desktop`. Server mode keeps
its existing client-side encryption protocol and claims. A server deployment
must only claim zero-knowledge while it has no configured decryption authority.

## Security boundary

The `sulla-vault` container is the only long-lived process allowed to hold the
vault master key, user key, item keys, decrypted credential fields, or refresh
tokens. The narrow host OS bootstrap helper is the sole exception: it asks
macOS Keychain/safeStorage to unwrap the cached master material, authenticates
the vault server through a pinned bootstrap identity and challenge proof,
delivers the bytes through the one-use authenticated handoff, zeros its
transient buffer, and exits. General Desktop services never retain, decrypt,
expose, log, or proxy that material. Restart and lock clear the container's
in-memory keys and revoke every bootstrap, broker, approval, and human-UI
session.

Local callers never receive credential plaintext or encrypted material that can
be unwrapped outside the vault. They submit a typed operation plus credential
references. The vault validates caller identity, policy, destination, method,
redirects, DNS resolution, and injection slots, injects credentials into the
outbound request, sends it, and returns a bounded sanitized response.

There are four non-interchangeable authorities:

1. A one-use bootstrap capability is bound to the Desktop bootstrap helper.
   The helper and server mutually authenticate using a pinned installation
   identity plus a one-use challenge before key release; loopback binding alone
   is not treated as peer authentication. It cannot execute requests or open
   the UI.
2. A broker capability is bound to one service identity and operation. It
   cannot reveal, list, edit, or export secrets. `askFirst` needs a separate
   one-use approval minted by the trusted Desktop prompt path; caller booleans
   are ignored.
3. A human UI session is HttpOnly, same-origin, CSRF-protected, short-lived, and
   bound to the isolated vault view. It cannot be used as a broker token.
4. A Desktop control capability can read status, lock, migrate, and mint a
   human session. It cannot bootstrap keys, approve requests, or execute broker
   operations.

## Local API contract

The container listens on port `8787`; Compose publishes that listener only at
`127.0.0.1:30135` on the Desktop/VM boundary. Mutating browser endpoints check
an exact origin and CSRF token. Service endpoints require constant-time token
checks plus a caller identifier. Errors use stable states: `vault_locked`,
`vault_unavailable`, `migration_required`, `migration_failed`,
`approval_required`, `policy_denied`, and `invalid_service_identity`.

| Endpoint | Caller | Result |
| --- | --- | --- |
| `POST /v1/desktop/bootstrap/challenge` | bootstrap helper | One-use challenge; no key data |
| `POST /v1/desktop/bootstrap/unlock` | bootstrap helper | Accepts transient key material, returns status only |
| `POST /v1/desktop/cache/challenge` | isolated bootstrap helper | Domain-separated, one-use mutual-authentication challenge |
| `POST /v1/desktop/cache/fetch` | isolated bootstrap helper | One-use helper-sealed master bytes; cleared on fetch, lock, expiry, or restart |
| `POST /v1/desktop/lock` | Desktop lifecycle | Clears keys and revokes all sessions |
| `GET /v1/desktop/status` | authenticated Desktop | Lock and migration state only |
| `POST /v1/desktop/migrate` | migration helper | Triggers container-owned read-only legacy import; plaintext never returns |
| `POST /v1/broker/execute` | trusted tool/provider service | Sanitized HTTP result; never credential material |
| `POST /v1/broker/approve` | trusted prompt service | One-use approval bound to the exact pending operation |
| `POST /v1/human/session` | isolated Desktop view creator | Short-lived UI cookie/bootstrap URL |
| `/vault/*` | isolated human renderer | Container-owned password UI and same-origin API |

`POST /v1/broker/credential`, agent private-key files, and decrypt callbacks are
invalid in local mode. Arbitrary function environment injection is unsupported
because it necessarily releases plaintext to agent code. Those calls fail with
`unsupported_secret_egress`; supported functions must use an opaque broker
request capability. Browser autofill is a human-visible exception: the
container binds the popup session to the browser process's exact tab and
origin, decrypts only after the human clicks Fill, and exposes a 30-second
one-use payload only to the pinned Desktop control channel. Desktop rechecks
the live main-frame origin before and after injection. The filled tab is opaque
to current and future agent DOM automation bridges until its next top-level
navigation; no tool response, renderer IPC, or generic broker API returns the
username or password.

## Request policy

Each broker operation contains a verified caller subject, agent and workload
identity, operation name, credential references, URL, method, headers/body
injection descriptors, response limits, and optional one-use approval ID. The
vault rejects unknown operations and properties, non-HTTPS destinations except
explicit loopback development policy, URL credentials, fragments, private or
link-local resolved addresses, DNS changes between validation and connect,
cross-origin redirects, unbounded bodies, and credential-shaped response
headers. Redirects are disabled by default.

OAuth refresh is a typed vault operation. Refresh tokens stay inside the vault;
only the provider response required by the calling product operation leaves,
after sanitization. MCP HTTP auth follows the same broker path. MCP stdio auth
and arbitrary process environment injection are unsupported in local mode until
the process protocol can use opaque request capabilities.

## Migration and rollback

Migration is staged and idempotent. The container reads `integration_values`
through a narrowly scoped read-only legacy database connection. It handles both
historical plaintext rows and `$VAULT$` ciphertext inside the vault process;
neither row type is copied through Desktop or a new API. A one-use bootstrap
handoff may include the legacy unwrap key, but no broad Electron RPC can read
it. The container rewrites into its own transaction, records a source
fingerprint per row, checks that every migrated item can be reopened, then
marks the batch committed.
Desktop marks the migration receipt but preserves old ciphertext for rollback;
there is no automatic deletion on receipt. A failure rolls back the vault
transaction and leaves legacy rows untouched. No plaintext crosses the
migration API.

Password change, recovery, and backup operate inside the vault container in
local mode. After setup, password change, or recovery, the vault stages the new
master bytes for at most 60 seconds. Only the isolated Keychain helper can
mutually authenticate with the bootstrap identity, derive the domain-separated
session key, unwrap that one response, store it with OS protection, zero its
buffer, and exit. The staged bytes are consumed once and are also cleared by
lock or restart; control, broker, approval, and human sessions cannot fetch
them. Synthetic fixtures in a separate test database are the only allowed
migration test input.

## File ownership and implementation progress

| Owner | Files | Required change | State |
| --- | --- | --- | --- |
| Vault runtime | `services/sulla-vault/src/*`, migrations | key custody, sessions, broker, policy, migration, UI API security | in progress |
| Desktop bootstrap/lifecycle | `DesktopVaultClient`, `VaultKeyService`, startup | narrow Keychain handoff, status/lock only; no decrypt methods | inventoried |
| Desktop integration metadata | `IntegrationService`, `IntegrationValueModel`, sync IPC | metadata and opaque refs only in local mode; no plaintext fallback | inventoried |
| Tool/provider routing | `services/sulla-tools`, GitHub/Slack/Discord/OAuth/MCP/provider clients | typed vault operations as final outbound stage | inventoried |
| Runtime functions | `SecretsCapabilityService`, `sullaSecretsServer`, launchers | remove plaintext env service; opaque request capability or fail closed | inventoried |
| Browser autofill | container popup, Desktop control client, browser tab manager | origin-bound one-use human injection; agent DOM access blocked while filled | implemented |
| Vault broker legacy | `pkg/rancher-desktop/vault-broker/*`, Lima mounts | remove agent-key provisioning and decrypt callback | inventoried |
| Desktop UI | vault route/window registration and `services/sulla-vault/console/local/*` | sandboxed container view, no Node/preload/general browser registry | in progress (UI worker) |

The consumer inventory is intentionally broader than the generic tool proxy.
It includes native GitHub tools and PR services, Slack and Discord clients,
gateway listeners, model providers, text-to-speech, Sulla Cloud/mobile, OAuth,
MCP, recipe expansion, threat proxy credentials, function runtimes, browser
autofill, and integration IPC. A local-mode plaintext fallback in any of these
paths is a release blocker.

