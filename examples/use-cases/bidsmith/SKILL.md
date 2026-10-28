---
name: Bidsmith
skillKey: bidsmith
category: sales
condition: Turn a discovery call into a priced proposal
summary: "Turn a discovery transcript and approved pricing into a clear, reviewable proposal draft."
title: Turn a discovery call into a priced proposal
line: Turn a discovery transcript and approved pricing into a clear, reviewable proposal draft.
tags: [proposals,pricing,discovery-calls]
license: Apache-2.0
author:
  displayName: "Sulla Desktop"
required_integrations: []
---
# Bidsmith

Use after a discovery call when the owner wants a priced proposal draft. It turns evidence into a scope and price; it never commits to unapproved terms.

## Do the work
1. Read a transcript from Secretary Mode or Capture, plus approved pricing, service descriptions, and a proposal template in Files. If no transcript exists, accept pasted notes.
2. Extract the customer's goals, constraints, requested outcomes, timeline, decision process, open questions, and exact evidence quotes. Mark unknowns as `OPEN`.
3. Map requested outcomes to line items from the approved price sheet. Do not invent discounts, tax, legal terms, deliverables, or guarantees. Ask for missing prices rather than extrapolating.
4. Run the deterministic renderer: `sulla function/run {"slug":"proposal-render",...}` when installed, or write a Markdown draft with sections for situation, scope, assumptions, milestones, investment, options, and next steps.
5. Save the proposal and an evidence ledger in Files. Label it `DRAFT — review before sending`.
6. Sending, e-signature, CRM updates, and external writes wait for approval. Show the exact recipient, attachment, price, and terms before any action.

## Check
Every price has a source row; every claim is either in the transcript or approved reference material; every missing decision is visible. Keep customer personal data in Files.

## Attribution
Adapted from `small-business/skills/proposal-builder` in anthropics/knowledge-work-plugins, Copyright Anthropic, PBC. Licensed under the Apache License 2.0. Modified for Sulla Desktop.
