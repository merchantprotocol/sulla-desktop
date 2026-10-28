---
sullaApi: ^1.0.0
hooks: []
slug: satchel
name: Satchel
title: Hand your accountant a clean tax packet
line: Turn closed books and receipts into an accountant-ready tax packet without filing anything.
description: Prepare a tax-season packet from Files, optional Drive receipts, and ledger exports; this is not tax advice.
category: finance
tags: [tax, accountant, receipts, 1099, finance]
license: Apache-2.0
---
# Satchel

Prepare source-linked tax material for an accountant. This is preparation, not tax advice, and it never files, pays, or sends anything.

## When to use
Use for “organize my tax documents”, “prepare the 1099 list”, or “make the accountant packet”. Confirm the books and period are closed before using ledger totals.

## Steps
1. Ask for country, tax year, entity type, currency, and whether the books are closed and reconciled. This pack's estimated-tax and 1099 guidance is US federal; for another country, assemble a closed-books packet and stop the US calculations.
2. Search existing destinations before creating anything: `sulla files/search '{"query":"tax packet receipts 1099"}'` and `sulla files/where '{"what":"accountant tax packet","kind":"finance records"}'`. Use Files as the source of truth. Optional receipts may be selected from a connected Drive; otherwise accept uploaded PDFs and CSV exports.
3. For a quarterly estimate, use the closed P&L or pasted CSV. Show YTD and annualized net income, prior payments, explicit assumptions, excluded state taxes, and the accountant's adjustment points. Never invent a bracket, wage base, or due date; cite current IRS figures or leave the number open.
4. For 1099 preparation, aggregate service payments by payee across the supplied ledger, PayPal, or Stripe exports. Flag the US $600 threshold, near-threshold $400–$599 rows, missing W-9/EIN status, likely duplicate payees, and processor 1099-K notes. Never include SSNs or full bank/card numbers.
5. Produce an index, source list, missing-document checklist, assumptions, and accountant questions. Label it `Prepared for review by your accountant — not tax advice.` Save only after checking the existing Files folder; never overwrite a human file.
6. Filing, contacting the accountant, changing ledger records, and sharing the packet require a separate explicit approval for the exact action. This skill only prepares drafts.

## Checks
Every amount has a source and period. Every assumption is visible. Unknowns are `OPEN`, not guessed. Keep personal financial data in Files, not chat.

## Attribution
Adapted from `small-business/skills/tax-season-organizer` in anthropics/knowledge-work-plugins, Copyright Anthropic, PBC. Licensed under the Apache License 2.0. Modified for Sulla Desktop.
