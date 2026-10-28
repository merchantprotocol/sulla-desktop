---
sullaApi: ^1.0.0
hooks: []
slug: proofmark
name: Proofmark
title: Check an analysis before anyone else sees it
line: Recompute key results, expose weak assumptions, and issue a clear share-or-revise verdict.
description: Reviews data sources, methodology, calculations, visualizations, bias, and reproducibility before an analysis reaches stakeholders.
category: data
tags: [data-quality, validation, analysis, review, reproducibility]
license: Apache-2.0
---
# Proofmark

Independently check an analysis before it is shared. Do not merely proofread its conclusions.

## When to use
Use for reports, spreadsheets, SQL results, notebooks, dashboards, charts, or decision memos whose numbers and claims need a pre-delivery review.

## Procedure
1. Collect the analysis, its source data, queries or formulas, metric definitions, time range, timezone, intended audience, and stated assumptions. Search Files first with `sulla files/search '{"query":"<analysis title or source>"}'`. If raw data or definitions are unavailable, label those checks unverified rather than guessing.
2. Restate the question and population. Confirm the data source, freshness, grain, exclusions, null policy, deduplication, and comparison baseline. Ask who is absent from the dataset and whether the selection depends on the outcome.
3. Recompute at least three material results independently: one headline metric, one subtotal-to-total reconciliation, and one rate or period comparison. For SQL-backed work, discover the current read-only PostgreSQL query tool with `sulla meta/browse_tools '{"query":"read-only PostgreSQL query"}'` and inspect the integration before running it. Never write to the source database.
4. Test high-risk failure modes: join multiplication, denominator changes, partial-versus-complete periods, average-of-averages, timezone boundaries, duplicates, survivorship or selection bias, small samples, outliers, Simpson's paradox, correlation presented as causation, and cherry-picked ranges.
5. Inspect charts against their underlying values. Bar axes normally start at zero; comparable panels use comparable scales; titles state the population and period; labels show units; colors and 3D effects do not distort the result. Verify that filters affect all related metrics consistently.
6. Run reasonableness checks. Compare totals to a known independent source when available, trace a few individual records, reverse-calculate a headline value, and investigate changes above 50%, suspicious round numbers, exact 0% or 100% rates, or identical segment values.
7. Produce a validation report with: overall assessment (`Ready to share`, `Share with noted caveats`, or `Needs revision`); methodology findings; issues ranked high/medium/low with impact; calculation spot-checks with expected and observed values; visualization findings; required caveats; and prioritized corrections. Separate verified facts from assumptions.
8. Save the report only when requested. Use `sulla files/where '{"what":"analysis validation report","kind":"report"}'` and link it to the reviewed artifact by name and version. Do not send, post, or publish the analysis; if the human asks to share it, prepare the exact action and request approval first.

## Completion standard
Another analyst can reproduce each spot-check, every unresolved limitation is visible, and the verdict is no stronger than the evidence.

---
Adapted from `data/skills/validate-data` in anthropics/knowledge-work-plugins, Copyright Anthropic, PBC. Licensed under the Apache License 2.0. Modified for Sulla Desktop.
