---
slug: sulla-tool-redis
label: Use the Sulla redis tools
trigger_when: When you need to read or update Redis keys.
trigger_actions: [redis, Sulla redis tool, tool call]
trigger_phrases: [redis]
scope: [tool-redis]
---

**When:** Use `exec` to dispatch an exact `sulla redis/<tool>` command. Discover current tools with `sulla meta/browse_tools '{"category":"redis"}'` before an unfamiliar call.

**Tools:**
- `sulla redis/decr '{"key":"<key>"}'`: Decrement the integer value of a Redis key by one. Required: key.
- `sulla redis/del '{"keys":"[]"}'`: Delete one or more Redis keys. Required: keys.
- `sulla redis/expire '{"key":"<key>","seconds":"1"}'`: Set a timeout on a Redis key. Required: key, seconds.
- `sulla redis/get '{"key":"<key>"}'`: Get the value of a Redis key. Required: key.
- `sulla redis/hget '{"key":"<key>","field":"<field>"}'`: Get the value of a field in a Redis hash. Required: key, field.
- `sulla redis/hgetall '{"key":"<key>"}'`: Get all fields and values from a Redis hash. Required: key.
- `sulla redis/hset '{"key":"<key>","field":"<field>","value":"<value>"}'`: Set the value of a field in a Redis hash. Required: key, field, value.
- `sulla redis/incr '{"key":"<key>"}'`: Increment the integer value of a Redis key by one. Required: key.
- `sulla redis/lpop '{"key":"<key>"}'`: Remove and return the first element of a Redis list. Required: key.
- `sulla redis/rpush '{"key":"<key>","values":"[]"}'`: Append one or more values to a Redis list. Required: key, values.
- `sulla redis/set '{"key":"<key>","value":"<value>"}'`: Set the value of a Redis key. Required: key, value.
- `sulla redis/ttl '{"key":"<key>"}'`: Get the time to live (TTL) of a Redis key. Required: key.

**Do:**
1. Discover the category when names or parameters may have changed.
2. Run the command through `exec`, passing one JSON object with required parameters.
3. Treat returned IDs, cursors, and SHAs as inputs to the next call; verify destructive or outward-facing results.

**Don't:**
- Don't store secrets or large payloads in Redis.
- Don't delete or overwrite keys without checking the key and TTL.
