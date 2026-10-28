---
sullaApi: ^1.0.0
hooks: []
slug: horizon-line
name: Horizon Line
title: See every renewal coming 90 days out
line: Turn contract dates into a prioritized renewal radar and owner reminders.
summary: "Reads a selected contract register, finds renewals due within 90 days, and saves a risk-ranked radar without changing records."
version: 1.0.0
category: operations
tags: [renewals, contracts, calendar, workflow]
license: Apache-2.0
---
# Horizon Line

Keep renewals visible before they become emergencies. Use a CSV, spreadsheet, contract register, or optional read-only CRM export.

## Run it
1. Read the named Files register after `sulla files/search`; use `sulla files/where` before selecting an output folder. Required fields are customer, contract or subscription, renewal date, owner, value, notice deadline, and status. Flag missing fields.
2. Normalize dates and time zones. Include renewals in the next 90 days and overdue notice windows; separately list dates that cannot be parsed. Never infer a renewal from a vague note.
3. Rank attention by notice deadline, days remaining, value, risk notes, and missing owner. Show the source row for every item and distinguish facts from risk hypotheses.
4. Save a radar report and a short weekly action list in Files. Create calendar reminders only when the human approves the exact title, date, calendar, and invitees with `sulla meta/ask_user_question` and Approve/Deny choices. Never send a renewal message automatically.

## Check
Report as-of date, source file, covered window, counts by urgency, missing fields, and unchanged source data. CRM is optional; an uploaded export is a complete fallback.

## Attribution
Adapted from `sales/skills/renewal-radar` in anthropics/knowledge-work-plugins, Copyright Anthropic, PBC. Apache-2.0. Modified for Sulla Desktop.
