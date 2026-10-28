---
slug: sulla-tool-pg
label: Use the Sulla pg tools
trigger_when: When you need to inspect or change PostgreSQL data, schema, or transactions.
trigger_actions: [pg, Sulla pg tool, tool call]
trigger_phrases: [PostgreSQL query, database read, SQL query, update database, transaction]
scope: [tool-pg]
---

**When:** Use `exec` to dispatch an exact `sulla pg/<tool>` command. Discover current tools with `sulla meta/browse_tools '{"category":"pg"}'` before an unfamiliar call.

**Tools:**

<!-- tools:generated:start -->
- `sulla pg/count '{"sql":"<sql>"}'`: Execute a PostgreSQL count query and return the count. Required: sql. Optional: params.
- `sulla pg/execute '{}'`: Execute a PostgreSQL statement and return execution results. Required: none. Optional: sql, query, statement, params.
- `sulla pg/query '{}'`: Execute a PostgreSQL query and return results. Required: none. Optional: sql, query, statement, params.
- `sulla pg/queryall '{"sql":"<sql>"}'`: Execute a PostgreSQL query and return all result rows. Required: sql. Optional: params.
- `sulla pg/queryone '{"sql":"<sql>"}'`: Execute a PostgreSQL query and return the first result row. Required: sql. Optional: params.
- `sulla pg/transaction '{"sql":"<sql>"}'`: Execute multiple PostgreSQL statements in a transaction. Required: sql. Optional: none.
<!-- tools:generated:end -->
**Do:**
1. Read with `sulla pg/queryall '{"sql":"SELECT ..."}'` or `sulla pg/queryone '{"sql":"SELECT ..."}'`.
2. Use `sulla pg/count '{"sql":"SELECT count(*) FROM ..."}'` for a count.
3. Before a write, identify the exact rows with a read-only query and make a restore plan.
4. Execute an authorized write with `sulla pg/execute '{"sql":"UPDATE ..."}'` or group related statements in `sulla pg/transaction '{"sql":"BEGIN; ...; COMMIT;"}'`.
5. Re-read the affected rows and verify the result.

**Don't:**
- Don't use write tools for exploratory reads.
- Don't interpolate untrusted values into SQL; use supported parameters.
- Don't run destructive SQL without backup, restore path, and authorization.
