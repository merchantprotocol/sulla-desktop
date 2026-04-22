---
routine: fetch-stripe-invoice
version: 1.2.3
title: Fetch Stripe Invoice
---

# Fetch Stripe Invoice

Fetches a single Stripe invoice by its ID and returns a structured object containing invoice metadata and optionally the list of line items.

## When to use

Use this routine when a workflow needs canonical invoice data from Stripe — billing reconciliation, receipt generation, refund logic, customer-support lookups. Do not use it for bulk invoice exports (see `list-stripe-invoices` for paginated queries).

## Inputs

- `invoice_id` (string, required) — The Stripe invoice ID, e.g. `in_1Nw...`.
- `include_line_items` (boolean, default `true`) — Whether to hydrate `invoice.lines` with the full line-item list.

## Outputs

- `invoice` (object) — The invoice record, conforming to `resources/invoice-schema.json`.

## Permissions

- Network: `api.stripe.com`
- Env: `STRIPE_KEY` (read from Sulla vault at invocation)

## Error handling

- Stripe `resource_missing` → routine returns `null` for `invoice`. Callers should handle this case.
- Stripe rate limit (429) → routine retries with exponential backoff up to 3 times. After that, the invocation fails.
- Network timeout (>30s) → invocation fails. Workflow can branch on failure.

## Example workflow usage

```yaml
- id: node-fetch
  type: workflow
  data:
    subtype: routine
    category: agent
    label: "Fetch Stripe Invoice"
    config:
      routineRef: fetch-stripe-invoice@1.2.3
      inputs:
        invoice_id: "{{ trigger.invoice_id }}"
```

## Notes for agents

- This routine is idempotent — calling it twice with the same `invoice_id` returns the same result (except for timestamps on the Stripe side).
- Prefer this routine over raw `integration-call` nodes when the downstream workflow needs typed invoice data. The output schema is stable across minor versions.
