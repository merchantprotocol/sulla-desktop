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
| Integration metadata/model reads | Secrets fail closed; container metadata sync pending | Secret/form/all-value access cannot fall back to the legacy model or synchronous IPC. A broker-authenticated sanitized endpoint must provide active account plus routing-safe properties from the container-owned item revision. |
| Arbitrary function env/stdin | Removed in Desktop mode | Returns `unsupported_secret_egress`; functions need an opaque outbound request capability. |
| Config-driven REST clients | Routed, registry pending | Chat/playbook callers issue exact account scopes and `ConfigApiClient` uses `catalog.http`. Service must validate each shipped manifest's destination and injection field instead of a broad allowlist. |
| OAuth token refresh | Routed | `oauth.refresh` injects refresh/client credentials only inside the authority, serializes per account, persists rotations, and returns expiry/scope metadata only. Legacy access-token getters explicitly reject Desktop secret egress. |
| OAuth initial exchange/adoption/revoke | Service custody incomplete | These flows still need typed authority operations that persist or delete the encrypted item before returning sanitized metadata; they cannot use the legacy OAuth token table in Desktop mode. |
| Google Drive OAuth consumer | Routed, registry pending | `catalog.http` injects `access_token` at `www.googleapis.com` under the exact active `google_drive` account; service needs the narrow shipped-manifest rule. |
| MCP HTTP | Routed, service edge cases pending | SDK `Request` method/headers/body/signal are preserved through execute-stream. Service must support explicitly credential-free items and 202/204 empty responses. |
| MCP stdio | Blocked fail-closed required | Secret env/stdin is incompatible; only an opaque request-capability protocol is acceptable. |
| Slack Web API | Routed | Tool calls use `slack.web-api` with the verified execution context and active account scope; token presence is not exposed to health checks. |
| Slack Socket Mode | Routed | Desktop opens the vault-owned relay, parses bounded NDJSON, ACKs typed events, forwards sanitized messages, and closes/aborts without instantiating Bolt with vault credentials. |
| Discord legacy SDK | Baseline dormant/unregistered; blocked in Desktop mode | No Discord factory is registered. The dormant token-SDK initializer explicitly refuses container-authority mode so it cannot read or decrypt a vault credential. Active config-driven Discord REST calls remain subject to the `discord.rest` broker policy. |
| Model/provider HTTP streaming | Routed | Provider SDK-compatible fetch adapters use execute-stream with exact provider/account scope, preserve non-2xx provider responses and propagate abort without a local key fallback. |
| Codex/Claude CLI providers and agent containers | Vault-backed lane unsupported unless opaque proxy configuration is accepted | Independent user-managed CLI login files are outside this migration and must not be read or copied. Credentials sourced from Sulla vault may never be materialized into CLI files or environment; use the existing broker base-URL path where supported and otherwise fail closed. |
| Provider model discovery | Routed | Desktop ignores caller API-key values and uses scoped `provider.discovery` with provider-specific GET host/path/header policy and bounded JSON output. |
| Text-to-speech providers | Routed | ElevenLabs/Grok use scoped `provider.audio` with provider-bound destinations/injections and binary stream output without local keys. |
| Agent browser autofill | Intentionally unsupported | The generic agent-readable browser is not an isolated human target. Fail with `unsupported_secret_egress`; container-hosted human reveal remains supported. |

## Release blockers

The unrouted rows above remain release blockers. There is deliberately no local
raw-key, plaintext database, environment-variable, or SDK-token fallback in the
new broker client.
