---
sullaApi: ^1.0.0
hooks: []
slug: sounding
name: Sounding
title: Profile a new spreadsheet before you trust it
line: Surface nulls, duplicates, type problems, outliers, and quality warnings before analysis.
summary: Profiles an uploaded CSV or spreadsheet with a deterministic function and explains limitations without changing the source.
version: 1.0.0
category: data
tags: [data-quality, csv, spreadsheets, profiling, analysis]
license: Apache-2.0
---
# Sounding

Profile a dataset before relying on it for a decision.

## Use
1. Ask for an uploaded CSV, spreadsheet export, or pasted rows. Preserve the original in Files; never overwrite it.
2. Validate headers, row count, inferred types, missingness, duplicate rows and keys, invalid values, numeric ranges, and likely outliers. Distinguish an outlier from an error; do not silently delete or impute.
3. Run the deterministic `sounding` function on normalized rows. Report the input assumptions and every warning. If the file is too large or malformed, return the exact repair needed.
4. Save a source-linked profile report only when requested using `sulla files/search '{"query":"<dataset> profile"}'` first and `sulla files/where '{"what":"data profile for <dataset>","kind":"data quality report"}'` for placement.
5. Recommend checks before analysis. Do not claim statistical significance or data correctness from a profile alone.

## Output
Schema summary, dimensions, null counts/rates, duplicate counts, unique counts, numeric min/max/quantiles where available, outlier flags, warnings, and next checks.

Adapted from `data/skills/explore-data` in anthropics/knowledge-work-plugins, Copyright Anthropic, PBC. Licensed under the Apache License 2.0. Modified for Sulla Desktop.
