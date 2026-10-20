# Models — AI provider & model inventory

Read-only visibility into which AI providers Sulla can use, what models each exposes, and how much you've been spending locally. This is the inventory layer behind the model picker — it does **not** switch the active model (that's a settings/UI action), it tells you what's available and healthy.

Three tools, all read-only:

| Tool | Purpose |
|------|---------|
| `sulla models/providers` | List every provider with connected/on vs disconnected/off state, whether its required CLI is installed in the Sulla VM, and whether Sulla can actually use it. |
| `sulla models/list` | List the models one provider exposes (live provider discovery, static-catalog fallback when discovery is unavailable). |
| `sulla models/usage` | Read locally-tracked model usage captured by Sulla. |

## `models/providers` — who can I run?
```bash
sulla models/providers '{}'                                    # all providers
sulla models/providers '{"include_disconnected":false}'        # only connected/on
```
Each row tells you three separate things — a provider can be *connected* (credential present) but still unusable if its CLI isn't installed in the VM, so check all three before assuming a provider works. `include_disconnected` defaults to `true`.

## `models/list` — what models does a provider have?
```bash
sulla models/list '{"provider":"claude-code"}'
sulla models/list '{"provider":"anthropic"}'
```
`provider` is required and is the provider id. Known ids in code include `claude-code`, `codex` and `grok`. Uses live discovery where the provider supports it and falls back to a bundled static catalog otherwise, so a list still comes back when a provider's discovery endpoint is down.

## `models/usage` — what have I spent locally?
```bash
sulla models/usage '{}'                                                   # last 24h, all tracked providers
sulla models/usage '{"provider":"codex","hours":168}'                     # codex, last 7 days
sulla models/usage '{"provider":"claude-code","model":"<model-id>"}'
```
Reads Sulla's own local usage tracking (`agent/usage/providerUsage.ts`). **Today it covers `codex` and `claude-code` only** — other providers' billing APIs are not queried, so a zero there means "not tracked," not "not used." `hours` defaults to 24. Filters: `provider`, `model`, `profile_id`.

## Notes
- All three are **read-only**. They never change the active model or touch credentials.
- Provider/model state is owned by `ModelProviderService` (`pkg/rancher-desktop/agent/services/ModelProviderService.ts`). Agent turns resolve their model through this layer — see [`environment/architecture.md`](../environment/architecture.md).
- CLI providers (`claude-code`, `codex`) need their CLI installed **in the Lima VM**; `models/providers` reports that per provider.

→ Back to [`tools/inventory.md`](inventory.md)
