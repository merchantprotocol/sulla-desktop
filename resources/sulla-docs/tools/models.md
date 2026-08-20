# Models — AI provider & model inventory

Read-only visibility into which AI providers Sulla can use, what models each exposes, and how much you've been spending locally. This is the inventory layer behind the model picker — it does **not** switch the active model (that's a settings/UI action), it tells you what's available and healthy.

Three tools, all read-only:

| Tool | Purpose |
|------|---------|
| `sulla models/models_providers` | List every provider with connected/on vs disconnected/off state, whether its required CLI is installed in the Sulla VM, and whether Sulla can actually use it. |
| `sulla models/models_list` | List the models one provider exposes (live provider discovery, static-catalog fallback when discovery is unavailable). |
| `sulla models/models_usage` | Read locally-tracked model usage captured by Sulla. |

## `models_providers` — who can I run?
```bash
sulla models/models_providers '{}'                        # all providers
sulla models/models_providers '{"include_disconnected":false}'  # only connected/on
```
Each row tells you three separate things — a provider can be *connected* (credential present) but still unusable if its CLI isn't installed in the VM, so check all three before assuming a provider works. `include_disconnected` defaults to `true`.

## `models_list` — what models does a provider have?
```bash
sulla models/models_list '{"provider":"claude-code"}'
sulla models/models_list '{"provider":"anthropic"}'
```
`provider` is the provider id — e.g. `codex`, `claude-code`, `grok`, `openai`, `anthropic`, `google`, `cohere`. Uses live discovery where the provider supports it and falls back to a bundled static catalog otherwise, so a list still comes back when a provider's discovery endpoint is down.

## `models_usage` — what have I spent locally?
```bash
sulla models/models_usage '{}'                                  # last 24h, all tracked providers
sulla models/models_usage '{"provider":"codex","hours":168}'    # codex, last 7 days
sulla models/models_usage '{"provider":"claude-code","model":"claude-opus-4-8"}'
```
Reads Sulla's own local usage tracking. **Today it covers `codex` and `claude-code` rolling usage only** — other providers' billing APIs are not queried, so a zero there means "not tracked," not "not used." `hours` defaults to 24; `provider` and `model` are optional filters.

## Notes
- All three are **read-only** — safe to call without confirmation, they never change the active model or touch credentials.
- Provider/model state is owned by `ModelProviderService` (registered at startup; it invalidates the LLM caches whenever the source of truth changes). Agent turns resolve their model through this layer — see [`environment/architecture.md`](../environment/architecture.md).
- CLI providers (`claude-code`, `codex`) need their CLI installed **in the Lima VM**; `models_providers` reports that per provider.

→ Back to [`tools/inventory.md`](inventory.md)
