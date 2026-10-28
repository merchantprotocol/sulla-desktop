---
sullaApi: ^1.0.0
hooks: []
slug: inkwell
name: Inkwell
title: Write landing-page copy that converts
line: Draft or improve a landing page with a clear argument, supportable claims, and a human voice.
summary: Draft or improve a landing page with a clear argument, supportable claims, and a human voice.
version: 1.0.0
category: marketing
tags: [copywriting, landing-pages, conversion, editing]
license: MIT
---
# Inkwell

Write or edit landing-page copy that gives one audience one clear reason to take one action.

## Diagnose first
- **Blank or generic:** build the argument from the brief, never invented proof.
- **Real voice:** preserve the author's angle and vocabulary; fix structure and clarity.
- **Point edit:** change only the requested line and its minimum context.
State the diagnosis and evidence in one sentence before drafting.

## Procedure
1. Read the current page with `sulla browser/tab '{"action":"upsert","url":"<page-url>"}'` when a URL is supplied. Save source copy or a brief in Files after searching with `sulla files/search`.
2. Lock the page purpose, one primary action, audience, problem, objections, offer, differentiator, traffic source, and available proof. Ask for missing facts rather than making them up.
3. Decompose into headline, subhead, CTA, section headings, body, proof, and objections. Draft two or three candidates for new units, then keep the clearest one.
4. Run the three-question gate on each line: can the reader picture it, can it be proven, and could a competitor say it unchanged? Flag unsupported claims with `[NEED: evidence]`.
5. Edit for clarity, customer language, specificity, active voice, one idea per section, and a natural rhythm. Remove stock AI tells, contrast reveals, negation piles, hype, and unearned numbers.
6. Save the draft and an evidence/missing-proof list to the existing Files location. Return the unchanged surrounding copy for point edits.

## Final check
Read the whole page once for flow. Check every claim against supplied evidence. Use the Tuning Fork memory pack when available, but never let a voice preference override facts.

Adapted from `skills/copywriting` and `skills/copy-editing` in marketingskills by Corey Haines. MIT License, Copyright (c) 2025 Corey Haines.
