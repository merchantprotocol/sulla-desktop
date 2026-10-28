---
sullaApi: ^1.0.0
hooks: []
slug: weigh-station
name: Weigh Station
title: Compare vendors and know what to negotiate
line: Turn proposals and performance data into a transparent TCO, risk review, and negotiation plan.
summary: Evaluates vendors for cost, risk, performance, fit, and exit terms using owner-supplied evidence.
version: 1.0.0
category: operations
tags: [vendors, procurement, tco, risk, negotiation]
license: Apache-2.0
---
# Weigh Station

Evaluate a vendor without mistaking a low sticker price for a low total cost.

## Use
1. Ask for vendor name, decision type (new, renewal, comparison), proposal or contract, current spend, expected usage, implementation, support, and exit details. Uploaded files, CSVs, and pasted figures are valid.
2. Search Files first: `sulla files/search '{"query":"<vendor> proposal contract evaluation"}'`. Use `sulla files/where '{"what":"vendor review for <vendor>","kind":"procurement analysis"}'` for the report destination.
3. Research only public claims with the browser after discovering its exact read operation via `sulla meta/browse_tools '{"query":"read a public vendor pricing page"}'`. Record URL and access date; never treat marketing claims as verified performance.
4. Build a TCO table covering license, implementation, migration, training, support, usage, and exit cost for year one and three years. State currency, assumptions, and missing inputs. Compare vendors side by side when asked.
5. Assess financial stability, security/compliance evidence, concentration, lock-in, continuity, SLA, support response, uptime, delivery cadence, and references. Label likelihood and impact; do not make legal or security-certification claims without evidence.
6. Return Proceed, Negotiate, or Pass with reasons and specific negotiation points. The recommendation is decision support, not procurement authorization. Save only when requested.

## Output
Summary, cost analysis, risk matrix, performance evidence, strengths, concerns, recommendation, assumptions, and negotiation points.

Adapted from `operations/skills/vendor-review` in anthropics/knowledge-work-plugins, Copyright Anthropic, PBC. Licensed under the Apache License 2.0. Modified for Sulla Desktop.
