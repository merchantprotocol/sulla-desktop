---
name: Crawlspace
skillKey: crawlspace
category: marketing
condition: Audit whether a public site is findable by search engines and AI assistants
summary: "Audit crawlability, rendering, robots, llms.txt, and structured data."
title: Check your site is findable by search and AI assistants
line: Audit crawlability, rendering, robots, llms.txt, and structured data.
tags: [seo, ai-search, crawlability, websites]
license: Apache-2.0
required_integrations: []
---
# Crawlspace

Use for a read-only search and AI visibility audit. It improves crawlability and factual clarity; it cannot make an assistant recommend a business.

## Do the work
1. Ask for the public URL and the pages or queries that matter. Use `sulla browser/tab` to open the site; do not log in or submit forms.
2. Compare rendered text with raw HTML. Check homepage, key service/product pages, contact/about, `robots.txt`, `sitemap.xml`, and `llms.txt` when present.
3. Run `sulla function/run '{"slug":"crawlspace-audit",...}'` on captured HTML and robots text when installed. Check titles, descriptions, headings, canonical links, JSON-LD schema, image alt text, internal links, and bot access.
4. If asked about AI answers, test a small set of customer queries in the browser and record exactly whether the site appeared and which sources were cited. Do not invent a visibility score or ranking.
5. Save a Files report with five prioritized findings, evidence URLs, raw-vs-rendered gaps, and copy-ready drafts for `robots.txt`, `llms.txt`, schema, titles, and descriptions. Never invent business facts.
6. DNS changes, CMS edits, publishing, and bulk catalog updates are staged and require approval. Provide exact records or patches, not direct writes.

## Check
Name every page and source that could not be reached. Separate verified facts, recommendations, and unknowns. Recheck changes no sooner than 30 days unless the owner asks for a technical check.

## Attribution
Adapted from `small-business/skills/seo-ai-visibility` in anthropics/knowledge-work-plugins, Copyright Anthropic, PBC. Licensed under the Apache License 2.0. Modified for Sulla Desktop.
Adapted from `marketingskills` by Corey Haines. MIT License, Copyright (c) 2025 Corey Haines.
