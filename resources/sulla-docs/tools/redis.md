# Redis

Sulla's KV / cache / list store. Container `sulla_redis` on port **30117** (host) inside Sulla VM. The agent has 12 tools for it. **Most agents will only ever read `sulla:bridge:human_presence`.**

## What's stored where

Redis is sparsely used. Primary namespaces:

| Key / namespace | Type | Purpose | Owner |
|----------------|------|---------|-------|
| `sulla:bridge:human_presence` | hash | Human presence state (availability, idle minutes, view, channel) | `HumanHeartbeatBridge` |
| `sulla_settings` | hash | **Cache only** for SullaSettingsModel. Do not read/write with redis_* tools (blocked). | `SullaSettingsModel` |
| Other namespaces | — | Queues, sessions, locks not actively used yet | — |

The server runs with persistence off (`--save "" --appendonly no` in `assets/sulla-docker-compose.yaml`). Restarting the container loses every key.

## Tools

| Tool | Purpose |
|------|---------|
| `sulla redis/get` | Get string value |
| `sulla redis/set` | Set string value (`{key, value, ttl?}`) |
| `sulla redis/del` | Delete key(s) (`{keys: [...]}`) |
| `sulla redis/incr` | Increment int (returns new value) |
| `sulla redis/decr` | Decrement int |
| `sulla redis/expire` | Set/update TTL on existing key (`{key, seconds}`) |
| `sulla redis/ttl` | Get remaining TTL (-1 = no expiry, -2 = missing) |
| `sulla redis/hget` | Get one hash field (`{key, field}`) |
| `sulla redis/hset` | Set one hash field (`{key, field, value}`) |
| `sulla redis/hgetall` | Get all hash fields |
| `sulla redis/lpop` | Pop first list element |
| `sulla redis/rpush` | Push values onto end of list (`{key, values: [...]}`) |

**Values are always strings.** JSON-encode/decode objects yourself.

## Common requests

### "What's the human's current state?"
```bash
sulla redis/hgetall '{"key":"sulla:bridge:human_presence"}'
```
Returns the full presence hash. Or use the higher-level wrapper:
```bash
sulla bridge/get_human_presence '{}'
```
The bridge tool is preferred — it parses and returns a typed object.

### "Read or write a Sulla Desktop setting"
**Do not use these Redis tools.** `sulla_settings` is owned by `SullaSettingsModel`. The `redis_*` tools **block** that key at runtime.

```bash
sulla settings/get '{"property":"heartbeatEnabled"}'
sulla settings/set '{"property":"heartbeatEnabled","value":"true","cast":"boolean"}'
```

### "Cache this small value with a 1-hour TTL"
```bash
sulla redis/set '{"key":"my-cache:topic-X","value":"...","ttl":3600}'
sulla redis/get '{"key":"my-cache:topic-X"}'
```

### "Increment a counter"
```bash
sulla redis/incr '{"key":"my-app:event-count"}'
```

### "Use a list as a simple queue"
```bash
sulla redis/rpush '{"key":"my-queue","values":["item-1","item-2"]}'
sulla redis/lpop '{"key":"my-queue"}'
```

### "What's in Redis?" (debug)
There's no `redis/keys` or `redis/scan` tool. Workaround:
```bash
sulla meta/exec '{"command":"docker exec sulla_redis redis-cli KEYS \"*\""}'
```
**Don't run KEYS on a busy Redis** — it blocks. Fine for Sulla's lightly-used instance.

## Hard rules

- **Don't write to `sulla:bridge:human_presence` directly.** Let `HumanHeartbeatBridge` own it. If you corrupt it, the heartbeat will make wrong decisions about whether to act autonomously.
- **Don't touch `sulla_settings` with redis_*.** That hash is SullaSettingsModel's cache. Raw reads can be stale; raw writes desync Postgres. Use `sulla settings/get` and `sulla settings/set`. The redis tools refuse the key.
- **Don't use Redis as the source of truth for anything durable.** It has no persistence (see above).
- **Namespace your keys.** Use prefixes like `agent:<your-purpose>:<key>` so you don't collide with future Sulla internals.
- **Strings only.** Don't try to store binary data — base64-encode it first.

## When NOT to use Redis

- Anything that needs to survive a Sulla Desktop restart → use Postgres
- Anything more than a few KB → use Postgres or a file
- Pub/sub between agents → use the channel-tag pattern (`<channel:heartbeat>...`), not Redis pub/sub
- Workflow / job state → use the Postgres `workflow_checkpoints` machinery, not Redis

## Reference

- Tool dir: `pkg/sulla-desktop/agent/tools/redis/`
- Manifest: `pkg/sulla-desktop/agent/tools/redis/manifests.ts`
- Blocked-key guard: `pkg/sulla-desktop/agent/tools/redis/settingsGuard.ts`
- Connection: `pkg/sulla-desktop/agent/database/RedisClient.ts` — default `redis://127.0.0.1:30117` (no auth), overridable with `SULLA_REDIS_URL`
- Bridge tool wrapper: `pkg/sulla-desktop/agent/tools/bridge/`
- Presence service: `pkg/sulla-desktop/agent/services/HumanHeartbeatBridge.ts`
