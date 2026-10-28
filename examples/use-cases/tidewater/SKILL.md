---
sullaApi: ^1.0.0
hooks: []
slug: tidewater
title: Forecast your cash 30, 60 and 90 days out
line: Turn a ledger export into a transparent cash forecast with variance bands.
description: Prepare a cash-flow snapshot from a connected ledger or CSV without posting transactions.
category: finance
tags: [cash-flow, finance, forecast, csv]
---
# Tidewater

Forecast cash at 30, 60, and 90 days from a ledger export or normalized CSV. This is planning information, not financial advice.

## When to use
Use when the human asks “what will cash look like?”, “forecast cash”, or wants a runway snapshot.

## Instructions
1. Prefer a CSV uploaded to Files with `date`, `amount`, and `kind` (`income` or `expense`); accept optional `recurring`. A ledger or payments integration is optional and must be read-only.
2. Check dates, signs, currency consistency, duplicate rows, and missing values. State the as-of date and assumptions.
3. Run `sulla function/run '{"slug":"tidewater","inputs":{"rows": [...],"as_of":"YYYY-MM-DD"}}'` and inspect the returned warnings. Do not invent missing transactions.
4. Present opening balance, base, low, and high values for each horizon, plus the drivers and uncertainty. Explain that the function’s bands are a planning sensitivity, not a probability interval.
5. Save a source-linked report to Files only when requested. Never post journal entries, move money, or contact a lender.

## Attribution
Adapted from `small-business/skills/cash-flow-snapshot` in anthropics/knowledge-work-plugins, Copyright Anthropic, PBC. Licensed under the Apache License 2.0. Modified for Sulla Desktop.
