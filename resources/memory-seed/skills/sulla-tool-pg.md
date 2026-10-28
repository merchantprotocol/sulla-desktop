---
slug: sulla-tool-pg
label: Query and safely change PostgreSQL data
trigger_when: When you need a database count, filtered rows, schema inspection, or a carefully verified PostgreSQL change.
trigger_actions: [count records, query rows, inspect a table, update database, run a transaction]
trigger_phrases: [how many signups this week, query the database, orders over 100, PostgreSQL query, database count, SQL query, update database, transaction, how many, count the, this week, signups, in the database]
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
1. Define the metric and boundaries first: table, field, time zone, inclusive start, exclusive end, filters, and whether the current period is partial. Inspect a small sample: `sulla pg/queryall '{"sql":"SELECT * FROM users ORDER BY created_at DESC LIMIT 20"}'`.
2. Parameterize values. Count a period with `sulla pg/queryone '{"sql":"SELECT count(*)::int AS signups FROM users WHERE created_at >= $1 AND created_at < $2","params":["<start-iso>","<end-iso>"]}'`. Fetch filtered rows with `sulla pg/queryall '{"sql":"SELECT id, total FROM orders WHERE total > $1 ORDER BY total DESC LIMIT 100","params":["100"]}'`.
3. Use `sulla pg/count '{"sql":"SELECT count(*) FROM orders WHERE total > 100"}'` only for a simple fixed count. Use `queryone` when the result needs a named field or parameters.
4. Validate a reported number: check nulls and duplicates, compare a neighboring period, and say which time zone, range, filters, and exclusions were used. For visual output, link `sulla-reply-with-rich-html`; do not turn one number into a chart.
5. Before a write, select the exact rows and count them, capture the values needed to restore them, and use a narrow predicate. Writes that delete data wait for the human's explicit go-ahead.
6. Execute an authorized non-destructive write with `sulla pg/execute '{"sql":"UPDATE orders SET status = $1 WHERE id = $2","params":["reviewed","<order-id>"]}'`. Use `sulla pg/transaction '{"sql":"UPDATE ...; INSERT ...;"}'` for related statements; the tool owns the transaction boundary, so do not add `BEGIN` or `COMMIT`.
7. Re-read the affected rows, confirm the expected row count and values, and record the restore statement or backup location.

**Check:** The query returns the intended grain and columns; date boundaries and time zone are explicit; a second query validates the headline count; writes affect only the pre-counted rows and can be restored.

**Cleanup:** Remove exported query scratch and redact personal data from reports. Do not leave temporary tables or open transactions.

**Don't:**
- Don't use write tools for exploratory reads.
- Don't interpolate untrusted values into SQL; use supported parameters.
- Don't use `SELECT *` for a report or an unbounded production extract; use it only for a small schema sample.
- Don't run destructive SQL without a backup, restore path, and the human's explicit tap.
