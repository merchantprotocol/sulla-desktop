# Tidewater

**Listing:** Tidewater — *Forecast your cash 30, 60 and 90 days out* — Turn a ledger export into a transparent cash forecast with variance bands.

Tidewater profiles a CSV or read-only ledger export and produces deterministic horizon totals. It keeps an audit-friendly warning list and never changes financial systems.

## Setup
No integration is required. Upload a CSV to Files or connect a ledger/payments account through `vault` for read-only access. Normalize rows to `date`, `amount`, `kind`, and optional `recurring`.

## Use and customize
Run the Tidewater skill with an as-of date. Customize horizons or the sensitivity policy in `main.py`; keep network permissions empty. Treat the result as planning material, not financial advice.

Adapted from `small-business/skills/cash-flow-snapshot` in anthropics/knowledge-work-plugins, Copyright Anthropic, PBC. Licensed under the Apache License 2.0. Modified for Sulla Desktop.
