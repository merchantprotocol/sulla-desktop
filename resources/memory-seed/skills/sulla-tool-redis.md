---
slug: sulla-tool-redis
label: Use the Sulla redis tools
trigger_when: When you need to inspect, set, expire, increment, or remove a Redis key or hash/list value.
trigger_actions: [redis, Sulla redis tool, tool call]
trigger_phrases: [Redis key, cache value, Redis TTL, Redis hash, Redis list]
scope: [tool-redis]
---

**When:** Use `exec` to dispatch an exact `sulla redis/<tool>` command. Discover current tools with `sulla meta/browse_tools '{"category":"redis"}'` before an unfamiliar call.

**Tools:**

<!-- tools:generated:start -->
- `sulla redis/decr '{"key":"<key>"}'`: Decrement the integer value of a Redis key by one. Required: key. Optional: none.
- `sulla redis/del '{"keys":[]}'`: Delete one or more Redis keys. Required: keys. Optional: none.
- `sulla redis/expire '{"key":"<key>","seconds":1}'`: Set a timeout on a Redis key. Required: key, seconds. Optional: none.
- `sulla redis/get '{"key":"<key>"}'`: Get the value of a Redis key. Required: key. Optional: none.
- `sulla redis/hget '{"key":"<key>","field":"<field>"}'`: Get the value of a field in a Redis hash. Required: key, field. Optional: none.
- `sulla redis/hgetall '{"key":"<key>"}'`: Get all fields and values from a Redis hash. Required: key. Optional: none.
- `sulla redis/hset '{"key":"<key>","field":"<field>","value":"<value>"}'`: Set the value of a field in a Redis hash. Required: key, field, value. Optional: none.
- `sulla redis/incr '{"key":"<key>"}'`: Increment the integer value of a Redis key by one. Required: key. Optional: none.
- `sulla redis/lpop '{"key":"<key>"}'`: Remove and return the first element of a Redis list. Required: key. Optional: none.
- `sulla redis/rpush '{"key":"<key>","values":[]}'`: Append one or more values to a Redis list. Required: key, values. Optional: none.
- `sulla redis/set '{"key":"<key>","value":"<value>"}'`: Set the value of a Redis key. Required: key, value. Optional: ttl.
- `sulla redis/ttl '{"key":"<key>"}'`: Get the time to live (TTL) of a Redis key. Required: key. Optional: none.
<!-- tools:generated:end -->
**Do:**
1. `sulla redis/get {"key":"<key>"}` and `sulla redis/ttl {"key":"<key>"}` to inspect a key first.
2. `sulla redis/hgetall {"key":"<hash>"}` to inspect a hash.
3. Set with `sulla redis/set {"key":"<key>","value":"<value>"}` and expire it with `sulla redis/expire {"key":"<key>","seconds":3600}`.
4. Verify the value and TTL after a write.

**Don't:**
- Don't store secrets or large payloads in Redis.
- Don't delete or overwrite a key before checking its current value and TTL.
