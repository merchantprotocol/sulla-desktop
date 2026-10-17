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
| Integration metadata/model reads | Routed metadata / fail-closed secrets | Only explicit metadata properties remain readable in Desktop mode. Secret/form/all-value access cannot fall back to the legacy model or synchronous IPC. |
| Arbitrary function env/stdin | Removed in Desktop mode | Returns `unsupported_secret_egress`; functions need an opaque outbound request capability. |
| Config-driven REST clients | Routed, registry pending | Chat/playbook callers issue exact account scopes and `ConfigApiClient` uses `catalog.http`. Service must validate each shipped manifest's destination and injection field instead of a broad allowlist. |
| OAuth token exchange/refresh | Service contract incomplete | `oauth.refresh` persists and sanitizes responses, but its current JSON/query injection cannot represent form-encoded refresh or Basic client authentication. Initial exchange/adoption/revoke also need service-owned typed operations. |
| Google Drive OAuth consumer | Routed, registry pending | `catalog.http` injects `access_token` at `www.googleapis.com` under the exact active `google_drive` account; service needs the narrow shipped-manifest rule. |
| MCP HTTP | Routed, service edge cases pending | SDK `Request` method/headers/body/signal are preserved through execute-stream. Service must support explicitly credential-free items and 202/204 empty responses. |
| MCP stdio | Blocked fail-closed required | Secret env/stdin is incompatible; only an opaque request-capability protocol is acceptable. |
| Slack Web API | Service operation ready, consumer pending | Must replace Bolt/WebClient token construction with scoped `slack.web-api` requests. |
| Slack Socket Mode | Relay contract published, payload schema/implementation pending | Client transport is available, but sanitized event and typed ACK/command payloads must be frozen before replacing Bolt. |
| Discord REST/gateway | Relay contract published, payload schema/implementation pending | Must replace discord.js token login and REST calls with `discord.rest` plus the service-owned gateway relay. |
| Model/provider HTTP streaming | Routed | Provider SDK-compatible fetch adapters use execute-stream with exact provider/account scope, preserve non-2xx provider responses and propagate abort without a local key fallback. |
| Provider model discovery | Service operation missing | Live authenticated `GET /models` needs provider-specific host/path and header policies; chat inference remains POST-only. Static catalog fallback is safe but not full live functionality. |
| Text-to-speech providers | Service operation missing | ElevenLabs/Grok audio needs a typed outbound operation with exact paths, key injection and bounded binary streaming. It cannot use the textual catalog/inference adapters. |
| Browser autofill | Service contract missing | Requires a human-approved vault-to-isolated-target operation carrying an opaque browser target and exact inspected origin; current Desktop script construction still sees plaintext. |

## Release blockers

The unrouted rows above remain release blockers. There is deliberately no local
raw-key, plaintext database, environment-variable, or SDK-token fallback in the
new broker client.
