---
slug: sulla-analyze-data
label: Analyze data and return a traceable report or dashboard
trigger_when: When the human wants a spreadsheet analyzed, a KPI dashboard, a signup count, trends explained, or a recurring client report from real data.
trigger_actions: [analyze a spreadsheet, calculate a KPI, build a dashboard, find trends, make a monthly report]
trigger_phrases: [analyze this spreadsheet, tell me the trends, how many signups this week, build me a dashboard, monthly client report, compare these KPIs, chart the results]
scope: [everyday-work, tool-pg, tool-gdrive, tool-models, sulla-agents, sulla-chat, sulla-files]
---

**When:** Use this when the answer requires calculation, validation, or visualization. For one cheap database count, use `sulla-tool-pg` directly. Use `analytics-worker` for multi-metric analysis or a polished dashboard; it is read-only.

**Do:**
1. State the question, decision, metric definitions, time window, time zone, comparison period, grain, filters, units, and source. Never guess an ambiguous business definition when it would change the answer.
2. Locate local data with `sulla files/search '{"query":"<file or report name>"}'`. For Google Drive, check the integration with `sulla vault/is_enabled '{"account_type":"google_drive"}'` and list its accounts with `sulla vault/list_accounts '{"account_type":"google_drive"}'`. Pass the returned account when needed: `sulla gdrive/read '{"file":"<sheet-id-or-url>","accountId":"<account-id>"}'` reads a Sheet as CSV; `sulla gdrive/download '{"file":"<sheet-id-or-url>","format":"csv","destinationDir":"/mnt/worktrees/_scratch/<job>","accountId":"<account-id>"}'` downloads it.
3. Query database data read-only. Inspect a sample with `sulla pg/queryall '{"sql":"SELECT * FROM <table> LIMIT 20"}'`; calculate a count with a parameterized query such as `sulla pg/queryone '{"sql":"SELECT count(*)::int AS signups FROM users WHERE created_at >= $1 AND created_at < $2","params":["<start-iso>","<end-iso>"]}'`. Follow `sulla-tool-pg` and do not write to source data.
4. Validate before calculating: row count, missing values, duplicates, field types, date boundaries, time zone, currency and units, partial periods, outliers, and whether totals reconcile. Record exclusions and transformations.
5. For multi-source or visual work, verify the specialist with `sulla agents/directory '{"slug":"analytics-worker"}'`, then launch it using `sulla-spawn-and-manage-agents`. Give the exact question, source paths or queries, metric definitions, period and time zone, comparison or target, privacy constraints, and required provenance. It returns a takeaway, rendered component, provenance, and caveats.
6. Pick the smallest honest visual: a KPI tile for one value, line for time, bars for comparison, table for exact values. Use `sulla-reply-with-rich-html`; label estimates and sample data, and never chart invented values.
7. For a monthly client report, compare the same definitions across periods, show outcomes before activity, include source/window/filters, and save the canonical report with `sulla files/where '{"what":"monthly client report for <client>","kind":"report"}'` plus `sulla-save-work-in-files`. Update the existing report series instead of creating duplicate `final` files.

**Check:** Recompute at least one headline metric independently; totals reconcile; periods are complete or labeled partial; every number has source, window, filters, and transformations; the report answers the stated decision.

**Cleanup:** Remove downloaded copies and calculation scratch from `/mnt/worktrees/_scratch/<job>/` when no longer needed. Keep only the finished report in Files. Do not alter or delete source data.

**Don't:**
- Don't upload private data to an external model or integration without authorization.
- Don't mix currencies, time zones, grains, or partial and complete periods without labeling them.
- Don't present correlation as causation or an estimate as an observed fact.
- Don't use a chart where one number or a small table is clearer.
