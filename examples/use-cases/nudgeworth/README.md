# Nudgeworth

Find overdue invoices, age receivables, and draft human-reviewable follow-ups without sending them.

## Setup
- Put a CSV or JSON ledger in a managed Files folder, or connect a read-capable ledger integration through vault.
- Optional: connect email read/draft access. Sending remains approval-gated.
- No credentials belong in prompts or files.

## Use and customize
Ask for “an AR aging report” or “draft invoice follow-ups.” Set the as-of date, bucket policy, tone, and output folder. Edit `SKILL.md` to match approved payment terms. Nothing sends or changes records without approval.

## Included kinds
The skill and scheduled workflow are included. The workflow reads a supplied export and asks Sulla to save a weekly report; it does not send mail.
