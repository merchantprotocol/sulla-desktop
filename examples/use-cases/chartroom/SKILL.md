---
sullaApi: ^1.0.0
hooks: []
slug: chartroom
name: Chartroom
title: Turn a CSV into a shareable dashboard
line: Build a self-contained, filterable HTML dashboard from a CSV or read-only query.
description: Creates a browser-ready dashboard with verified metrics, useful charts, filters, and a detail table while keeping source data traceable.
category: data
tags: [dashboard, csv, charts, reporting, analytics]
license: Apache-2.0
---
# Chartroom

Build a self-contained HTML dashboard that opens in a browser without a server.

## When to use
Use when the human wants a CSV, pasted table, or read-only query turned into an executive overview, operational monitor, or shareable visual report.

## Procedure
1. Define the audience, decision, headline metrics, useful dimensions, date range, timezone, and source. Prefer a file already in Files. Run `sulla files/search '{"query":"<source filename or subject>"}'` before asking for another copy. A PostgreSQL source is optional; discover its exact read-only query tool with `sulla meta/browse_tools '{"query":"query PostgreSQL without changing data"}'` before use.
2. Profile the data before charting. Record row count, columns, types, nulls, duplicates, date coverage, units, and currency. Reject mixed grains, ambiguous signs, or unexplained totals. Never invent real-looking rows; clearly label any demonstration data as sample data.
3. Recompute every KPI from the source. Choose two to four headline metrics, one primary trend or comparison, up to two supporting charts, and an optional sortable detail table. Use line charts for time, bars for comparisons, stacked bars for composition over time, and doughnuts only for fewer than six parts.
4. Build one HTML file with embedded CSS, JavaScript, and source data. Prefer browser-native SVG or canvas so the file works offline. If an external chart library is necessary, disclose that the dashboard needs network access and pin its version and integrity hash. Escape source values before inserting them into HTML or script; do not treat cell content as code.
5. Add filters only when they answer a real question. A filter must update KPIs, every chart, and the table together. Include an as-of date, source note, metric definitions, timezone, and known limitations. Use accessible labels, keyboard controls, adequate contrast, responsive layout, and print styles.
6. Use `sulla files/where '{"what":"self-contained HTML dashboard","kind":"report"}'` to choose the destination. Save the HTML in Files with a descriptive stable name. Do not create a duplicate “final” file.
7. Preview it with `sulla browser/tab '{"action":"upsert","url":"file://<absolute-files-path>"}'` when local file URLs are supported, otherwise open a safe local preview URL. Inspect with `sulla browser/screenshot '{}'`. Check narrow and wide layouts, each filter, empty states, table sorting, tooltip labels, console/network errors, and print output.
8. Reconcile every displayed total to the source after filtering. Report the saved path, source as-of date, row count, checks performed, and any external dependency. Creating a public Files link is an outward-facing action, so prepare it and ask the human to approve before calling `sulla files/link`.

## Completion standard
The dashboard opens without a build step, contains no secrets, preserves source traceability, survives empty or unusual data, and every visible number reconciles to the input.

---
Adapted from `data/skills/build-dashboard` in anthropics/knowledge-work-plugins, Copyright Anthropic, PBC. Licensed under the Apache License 2.0. Modified for Sulla Desktop.
