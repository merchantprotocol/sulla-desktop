# Settings

`SullaSettingsModel` is the **single authoritative settings path**. Product code already uses it. Agents must too.

## Tools

| Tool | Purpose |
|------|---------|
| `sulla settings/get` | Read a setting (Redis cache → Postgres → file fallback). Optional `default` if unset. |
| `sulla settings/set` | Write a setting through Postgres AND the Redis cache |

```bash
sulla settings/get '{"property":"heartbeatEnabled"}'
sulla settings/set '{"property":"heartbeatEnabled","value":"true","cast":"boolean"}'
```

`cast` is optional (`string` | `number` | `boolean` | `json` | `array`). Defaults to `typeof value`.

## Why

The Redis `sulla_settings` hash and the Postgres `sulla_settings` table can disagree if something writes to one and skips the other. `SullaSettingsModel` writes both. The agent's `redis_*` tools refuse the `sulla_settings` key and point here, so these two tools are the only agent path. Do not replace `SullaSettingsModel`. Redis is its cache, not a second source of truth.

## Readers and writers

Product code reads and writes durable settings through `SullaSettingsModel`. Examples:

| File | What it reads/writes |
|------|----------------------|
| `main/sullaEvents.ts` | IPC `sulla-settings-get/set/delete` (renderer proxy) |
| `config/settingsImpl.ts` | host-access / administrative gates |
| `backend/sullaRuntimeBackend.ts` | API token, Claude creds, compose secrets, proxy knobs |
| `main/desktopRelay.ts` | `pairedMobileUserId` |
| `main/deviceIdentity.ts` | device id |
| `composables/useTheme.ts` | theme |
| `main/claudeCodeTest.ts` | Claude OAuth / API key |

No product file calls `redisClient.hget('sulla_settings', …)` except `SullaSettingsModel` itself.

The Electron settings store (`settings.json`, managed by the internal settings API) is a **different** surface — app / VM knobs — not the `sulla_settings` hash. Leave it alone.

## Hard rules

- Never `redis/hget`, `redis/hset`, `redis/hgetall` or `redis/del` the `sulla_settings` hash.
- Never invent a second settings writer.
- Heartbeat on/off is the human's manual control. Do not flip `heartbeatEnabled` unless they ask.
