---
slug: sulla-automate-business-routines
label: Run and automate recurring business operations safely
trigger_when: When the human wants to plan inventory orders, log receipts, track contract renewals, capture web leads in a CRM, draft review replies, or re-engage inactive customers.
trigger_actions: [plan inventory order, log expense receipt, track renewals, capture CRM leads, draft review replies, draft customer check-ins]
trigger_phrases: [what should I order this week, log this expense receipt, track which contracts renew soon, capture leads into the CRM, draft responses to our new reviews, customers haven't ordered lately, draft check-ins, automate this business routine]
scope: [sulla-workflows, tool-vault, sulla-files]
---

**When:** Complete a bounded run now, then build a workflow only when the job genuinely recurs. Link to `sulla-use-an-integration` when present; otherwise use the verified vault flow below. Link to `sulla-build-workflow` for graph details.

**Do:**
1. Define the source, destination, fields, selection rule, cadence, owner, approval point, duplicate key, and success evidence. Ask only for missing business rules; never guess reorder thresholds, tax treatment, renewal notice periods, or customer eligibility.
2. Check the relevant integration: `sulla vault/is_enabled '{"account_type":"<cataloged-account-type>"}'` and `sulla vault/list_accounts '{"account_type":"<cataloged-account-type>"}'`. If absent, open `sulla ui/open_tab '{"mode":"integrations"}'` and name the service the human must connect.
3. Discover the exact operation before calling it: `sulla meta/browse_tools '{"query":"<service> <read or write operation>"}'`. Use the returned `sulla <account_id>/<slug> '<json>'` or MCP command. For owner-configured raw API credentials, list safe ids with `sulla vault/list_api_keys '{}'` and use `sulla vault/request '{"item":"<item-id>","method":"GET","url":"https://<allowed-host>/<documented-path>"}'`. Never expose the secret or invent an endpoint.
4. Read a bounded source window. Normalize ids, dates, currency, units, customer consent, and timezone. Deduplicate before any write.
5. Apply the job-specific rule:
   - **Orders:** combine on-hand, committed, inbound, lead time, minimums, safety stock, and forecast; output a proposed quantity and reason per item.
   - **Receipt:** extract merchant, date, currency, total, tax, category, payment account reference, and receipt file; flag uncertainty and duplicates.
   - **Renewals:** record counterparty, contract, renewal date, notice deadline, owner, value, auto-renewal, and source link; calculate dates from the contract, not memory.
   - **Lead capture:** map consented form fields to CRM fields, preserve source and timestamp, and upsert on a stable identity.
   - **Reviews:** quote the actual issue, draft a specific response, avoid admissions or incentives, and escalate safety, legal, privacy, or refund disputes.
   - **Inactive customers:** define inactivity from order history, exclude opted-out or sensitive accounts, and draft individualized check-ins without claiming a relationship not shown in the data.
6. Produce a dry-run table with proposed creates, updates, skips, duplicates, and errors. Save a finished report only if the human will reuse it; keep transient payloads in scratch.
7. Get one explicit approval for the exact outward batch or financial record writes: `sulla meta/ask_user_question '{"questions":[{"header":"Run business batch","question":"Apply the reviewed creates, updates, and messages?","options":[{"label":"Approve","description":"Apply exactly this reviewed batch."},{"label":"Deny","description":"Keep the dry run and change nothing."}]}]}'`. Ordering, paying, sending, posting, and deleting always require the human's tap.
8. After **Approve**, write with stable idempotency keys. Re-read destination records and reconcile counts. Stop on auth failure, schema drift, duplicate growth, or a total outside the reviewed bounds.
9. If recurring, turn the proven procedure into a draft workflow. Put data collection and drafting before a `user-input` approval node; put every external message, order, payment, deletion, or posting after it. Validate, dry-run, import, publish through Decide, enable, refresh schedules, and verify the next fire.

**Check:** Source and destination counts reconcile; every change has an external id; duplicates and failures are explicit; no send, post, pay, order, delete, or consequential write occurred without approval.

**Cleanup:** Remove raw exports, receipt OCR scratch, and payload files. Do not delete source records or human Files as cleanup.

**Traps:** Do not treat a sample workflow under `examples/` as installed. Do not make tax, legal, inventory, or consent rules up. Do not let a recurring workflow bypass the approval node.
