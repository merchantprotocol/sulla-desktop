# Redis

Sulla's KV / cache / list store. Container `sulla_redis` on port **30117** (host) inside Lima. The agent has 12 tools for it. **Most agents will only ever read `sulla:bridge:human_presence`.**

## What's stored where

The codebase has been audited — Redis is sparsely used today. Primary namespaces:

| Key / namespace | Type | Purpose | Owner |
|----------------|------|---------|-------|
| `sulla:bridge:human_presence` | hash | Human presence state (availability, idle minutes, view, channel) | `HumanHeartbeatBridge` |
| Other namespaces (anticipated) | — | Queues, sessions, locks not actively used yet | — |

Pub/sub channels: **none active**. Sulla uses WebSocket channels (BackendGraphWebSocketService) for inter-agent comms, not Redis pub/sub. The wire is there (`RedisClient.publish()`) but no active subscribers.

## Tools

| Tool | Purpose |
|------|---------|
| `sulla redis/redis_get` | Get string value |
| `sulla redis/redis_set` | Set string value (`{key, value, ttl?}`) |
| `sulla redis/redis_del` | Delete key(s) (`{keys: [...]}`) |
| `sulla redis/redis_incr` | Increment int (returns new value) |
| `sulla redis/redis_decr` | Decrement int |
| `sulla redis/redis_expire` | Set/update TTL on existing key (`{key, seconds}`) |
| `sulla redis/redis_ttl` | Get remaining TTL (-1 = no expiry, -2 = missing) |
| `sulla redis/redis_hget` | Get one hash field (`{key, field}`) |
| `sulla redis/redis_hset` | Set one hash field (`{key, field, value}`) |
| `sulla redis/redis_hgetall` | Get all hash fields |
| `sulla redis/redis_lpop` | Pop first list element |
| `sulla redis/redis_rpush` | Push values onto end of list (`{key, values: [...]}`) |

**Values are always strings.** JSON-encode/decode objects yourself.

## Common requests

### "What's the human's current state?"
```bash
sulla redis/redis_hgetall '{"key":"sulla:bridge:human_presence"}'
```
Returns the full presence hash. Or use the higher-level wrapper:
```bash
sulla bridge/get_human_presence '{}'
```
The bridge tool is preferred — it parses and returns a typed object.

### "Cache this small value with a 1-hour TTL"
```bash
sulla redis/redis_set '{"key":"my-cache:topic-X","value":"...","ttl":3600}'
sulla redis/redis_get '{"key":"my-cache:topic-X"}'
```

### "Increment a counter"
```bash
sulla redis/redis_incr '{"key":"my-app:event-count"}'
```

### "Use a list as a simple queue"
```bash
sulla redis/redis_rpush '{"key":"my-queue","values":["item-1","item-2"]}'
sulla redis/redis_lpop '{"key":"my-queue"}'
```

### "What's in Redis?" (debug)
There's no `redis_keys` or `redis_scan` tool. Workaround:
```bash
sulla meta/exec '{"command":"docker exec sulla_redis redis-cli KEYS \"*\""}'
```
**Don't run KEYS on a busy Redis** — it blocks. Fine for Sulla's lightly-used instance.

## Hard rules

- **Don't write to `sulla:bridge:human_presence` directly.** Let the `HumanPresenceTracker` (frontend) and `HumanHeartbeatBridge` (service) own it. If you corrupt it, the heartbeat will make wrong decisions about whether to act autonomously.
- **Don't use Redis as the source of truth for anything durable.** Sulla's Redis runs without persistence — restarting the container loses all keys.
- **Namespace your keys.** Use prefixes like `agent:<your-purpose>:<key>` so you don't collide with future Sulla internals.
- **Strings only.** Don't try to store binary data — base64-encode it first.

## When NOT to use Redis

- Anything that needs to survive a Sulla Desktop restart → use Postgres
- Anything more than a few KB → use Postgres or a file
- Pub/sub between agents → use the channel-tag pattern (`<channel:workbench>...`), not Redis pub/sub
- Workflow / job state → use the Postgres `workflow_checkpoints` machinery, not Redis

## Reference

- Tool dir: `pkg/rancher-desktop/agent/tools/redis/`
- Manifest: `pkg/rancher-desktop/agent/tools/redis/manifests.ts`
- Connection: `redis://127.0.0.1:30117` (no auth)
- Bridge tool wrapper: `pkg/rancher-desktop/agent/tools/bridge/`
- Presence service: `pkg/rancher-desktop/agent/services/HumanHeartbeatBridge.ts`
