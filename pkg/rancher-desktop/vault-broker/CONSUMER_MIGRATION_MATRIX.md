# Local vault consumer migration matrix

This inventory is for `SULLA_VAULT_MODE=desktop`. Server-mode compatibility is
not evidence that a Desktop consumer is safe. A row is complete only when no
credential plaintext, wrapped key, or decrypt callback crosses into the caller.

| Consumer | Current branch state | Remaining contract/work |
| --- | --- | --- |
| Broker client | Routed | Bounded execute and streamed execute preserve verified claims; approval is a separate trusted client. |
| Legacy broker decrypt callback | Removed | None; `/v1/broker/credential`, agent private-key files, and `useCredential` are gone. |
| GitHub REST/GraphQL (37 Octokit tools) | Routed | Uses one shared `request.fetch` adapter; the vault injects the PAT and sends the request. |
| Native git fetch/pull/push | Routed | Per-command random scoped loopback URL feeds binary smart HTTP through `github.git`; no PAT enters argv, env, URL, git config, or askpass. |
| Integration metadata/model reads | Routed | Main/tools use the broker-authenticated sanitized metadata API; renderer settings use two narrow metadata-only IPC calls. Unconfigured reads are empty/disconnected and never fall back to legacy values. Active-account changes are persisted by the container authority. |
| Arbitrary function env/stdin | Removed in Desktop mode | Returns `unsupported_secret_egress`; functions need an opaque outbound request capability. |
| Config-driven REST clients | Routed | Chat/playbook callers issue exact account scopes and `ConfigApiClient` uses `catalog.http`; the authority validates shipped-manifest destination, method, path, and injection fields. |
| OAuth token refresh | Routed | `oauth.refresh` injects refresh/client credentials only inside the authority, serializes per account, persists rotations, and returns expiry/scope metadata only. Legacy access-token getters explicitly reject Desktop secret egress. |
| OAuth initial exchange/adoption/revoke | Exchange and revoke routed; raw-token adoption intentionally unsupported | Authorization-code exchange and revoke execute in the authority, persist/clear encrypted token fields first, and return metadata only. Dynamic registration and callers already holding raw external tokens remain blocked until acquisition itself is vault-owned. |
| Google Drive OAuth consumer | Routed | `catalog.http` injects `access_token` at `www.googleapis.com` under the exact active `google_drive` account and shipped-manifest policy. |
| Sulla Cloud mobile API/push | Routed | Mobile tools and mobile `notify_user` delivery receive one exact signed `sulla-cloud` active-account scope from the trusted catalog issuer; HTTP adapters do not mint replacement scopes or receive the token. |
| Enterprise gateway HTTP/WebSocket | Routed | Session create/delete use `enterprise.gateway.http`; lobby/session/audio sockets live inside the vault relay with typed commands, bounded audio chunks, sanitized NDJSON events, reconnect/backpressure, and lock closure. |
| MCP HTTP | Routed | SDK `Request` method/headers/body/signal are preserved through execute-stream; authority policy supports registered credential-free endpoints and empty 202/204 responses. |
| MCP stdio | Blocked fail-closed required | Secret env/stdin is incompatible; only an opaque request-capability protocol is acceptable. |
| Slack Web API | Routed | Tool calls use `slack.web-api` with the verified execution context and active account scope; token presence is not exposed to health checks. |
| Slack Socket Mode | Routed | Desktop opens the vault-owned relay, parses bounded NDJSON, ACKs typed events, forwards sanitized messages, and closes/aborts without instantiating Bolt with vault credentials. |
| Discord legacy SDK | Baseline dormant/unregistered; blocked in Desktop mode | No Discord factory is registered. The dormant token-SDK initializer explicitly refuses container-authority mode so it cannot read or decrypt a vault credential. Active config-driven Discord REST calls remain subject to the `discord.rest` broker policy. |
| Model/provider HTTP streaming | Routed | Provider SDK-compatible fetch adapters use execute-stream with exact provider/account scope, preserve non-2xx provider responses and propagate abort without a local key fallback. |
| Codex/Claude CLI providers and agent containers | Vault-backed lane unsupported unless opaque proxy configuration is accepted | Independent user-managed CLI login files are outside this migration and must not be read or copied. Credentials sourced from Sulla vault may never be materialized into CLI files or environment; use the existing broker base-URL path where supported and otherwise fail closed. |
| Provider model discovery | Routed | Desktop ignores caller API-key values and uses scoped `provider.discovery` with provider-specific GET host/path/header policy and bounded JSON output. |
| Text-to-speech providers | Routed | ElevenLabs/Grok use scoped `provider.audio` with provider-bound destinations/injections and binary stream output without local keys. |
| Agent browser autofill | Intentionally unsupported | The generic agent-readable browser is not an isolated human target. Fail with `unsupported_secret_egress`; container-hosted human reveal remains supported. |

## Intentional compatibility boundaries

MCP stdio secret environment injection, generic agent-browser autofill,
vault-backed external CLI login files, OAuth dynamic client registration, and
raw-token adoption remain explicitly unsupported because each would materialize
a credential outside final outbound authority custody. There is deliberately no
local raw-key, plaintext database, environment-variable, or SDK-token fallback.
