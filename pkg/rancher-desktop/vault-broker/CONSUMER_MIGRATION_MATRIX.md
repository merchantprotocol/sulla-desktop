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
| Integration metadata/model reads | Fail-closed | Only explicit metadata properties remain readable in Desktop mode. Secret/form/all-value access must move to container UI or outbound broker calls. |
| Arbitrary function env/stdin | Removed in Desktop mode | Returns `unsupported_secret_egress`; functions need an opaque outbound request capability. |
| Config-driven REST clients | Inventory complete | Needs verified execution context threaded from each caller before `ConfigApiClient` can use the broker. Existing chat/playbook callers do not all carry one. |
| OAuth token exchange/refresh | Not routed | Must become typed vault operations; `oauth_tokens` Desktop reads/writes cannot remain in Electron/Postgres. |
| MCP HTTP | Not routed | SDK transport needs a broker-backed fetch plus verified caller context. SSE/streamable HTTP can use execute-stream. |
| MCP stdio | Blocked fail-closed required | Secret env/stdin is incompatible; only an opaque request-capability protocol is acceptable. |
| Slack Web API | Not routed | WebClient can use broker fetch after verified context is attached. |
| Slack Socket Mode | Contract gap | SDK currently requires bot/app tokens for WebSocket setup; needs vault-owned socket relay or opaque SDK transport. |
| Discord gateway | Contract gap | discord.js login currently requires a plaintext bot token; needs vault-owned gateway relay or opaque SDK transport. |
| Model/provider HTTP streaming | Contract defined, adapters pending | Use `/v1/broker/execute-stream`, propagate abort, and return the sanitized `Response` body stream directly. |
| Browser autofill | Not routed | Must be a human-approved vault-to-isolated-target operation; no tool response may include username/password. |

## Release blockers

The unrouted rows above remain release blockers. There is deliberately no local
raw-key, plaintext database, environment-variable, or SDK-token fallback in the
new broker client.
