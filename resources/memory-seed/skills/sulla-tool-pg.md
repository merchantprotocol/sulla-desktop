---
slug: sulla-tool-pg
label: Use the Sulla pg tools
trigger_when: When you need to query or update the PostgreSQL database.
trigger_actions: [pg, Sulla pg tool, tool call]
trigger_phrases: [pg]
scope: [tool-pg]
---

**When:** Use `exec` to dispatch an exact `sulla pg/<tool>` command. Discover current tools with `sulla meta/browse_tools '{"category":"pg"}'` before an unfamiliar call.

**Tools:**
- `sulla pg/count '{"sql":"<sql>"}'`: Execute a PostgreSQL count query and return the count. Required: sql.
- `sulla pg/execute '{}'`: Execute a PostgreSQL statement and return execution results. Required: none.
- `sulla pg/query '{}'`: Execute a PostgreSQL query and return results. Required: none.
- `sulla pg/queryall '{"sql":"<sql>"}'`: Execute a PostgreSQL query and return all result rows. Required: sql.
- `sulla pg/queryone '{"sql":"<sql>"}'`: Execute a PostgreSQL query and return the first result row. Required: sql.
- `sulla pg/transaction '{"sql":"<sql>"}'`: Execute multiple PostgreSQL statements in a transaction. Required: sql.

**Do:**
1. Discover the category when names or parameters may have changed.
2. Run the command through `exec`, passing one JSON object with required parameters.
3. Treat returned IDs, cursors, and SHAs as inputs to the next call; verify destructive or outward-facing results.

**Don't:**
- Don't run writes through read-only query tools.
- Don't interpolate untrusted values into SQL; use `params`.
- Don't run destructive SQL without a backup/restore path and explicit authorization.
