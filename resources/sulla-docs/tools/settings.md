# Settings

`SullaSettingsModel` is the **single authoritative settings path**. Product code already uses it. Agents must too.

## Tools

| Tool | Purpose |
|------|---------|
| `sulla settings/settings_get` | Read a setting (Redis cache → Postgres → file fallback) |
| `sulla settings/settings_set` | Write a setting through Postgres AND the Redis cache |

```bash
sulla settings/settings_get '{"property":"heartbeatEnabled"}'
sulla settings/settings_set '{"property":"heartbeatEnabled","value":"true","cast":"boolean"}'
```

`cast` is optional (`string` | `number` | `boolean` | `json` | `array`). Defaults to `typeof value`.

## Why this exists

Sulla used to have a dual-store gotcha: Redis `sulla_settings` and Postgres `sulla_settings` could disagree (`remoteProvider` showing grok in one store and claude-code in the other). The model already owned the correct write-through path. The remaining hole was **agent Redis tools** — a raw `hget`/`hset` on that hash bypassed the model.

That hole is now closed two ways:
1. `redis_*` tools **refuse** the `sulla_settings` key and point here.
2. These tools are the replacement.

Do **not** replace `SullaSettingsModel`. Promote it. Redis is its cache, not a second source of truth.

## Settings-read map (verified 2026-08-13)

Every product read/write of durable settings already goes through `SullaSettingsModel.get` / `.set` / `.delete` / `.bootstrap`. Representative owners:

| Owner | What it reads/writes |
|-------|----------------------|
| `sulla.ts` | bootstrap, `kubernetes.enabled`, `pathUserData` |
| `main/sullaEvents.ts` | IPC `sulla-settings-get/set/delete` (renderer proxy) |
| `config/settingsImpl.ts` | host-access / administrative gates |
| `backend/lima.ts` | API token, Claude creds, compose secrets, proxy knobs |
| `main/desktopRelay.ts` | `pairedMobileUserId` |
| `main/deviceIdentity.ts` | device id |
| `SullaWebRequestFixer.ts` | persisted cookies |
| `composables/useTheme.ts` | theme |
| `main/claudeCodeTest.ts` | Claude OAuth / API key |

**No product file** calls `redisClient.hget('sulla_settings', …)` except `SullaSettingsModel` itself.

The Electron settings-store (`settings.json` via `rdctl_list_settings`) is a **different** surface — Rancher Desktop / k8s / VM knobs — not the `sulla_settings` hash. Leave it alone.

## Hard rules

- Never `redis_hget` / `redis_hset` / `redis_hgetall` / `redis_del` the `sulla_settings` hash.
- Never invent a second settings writer.
- Heartbeat on/off is the human's manual control. Do not flip `heartbeatEnabled` unless they ask.
