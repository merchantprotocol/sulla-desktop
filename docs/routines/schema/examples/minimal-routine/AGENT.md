---
name: Dedupe Emails
summary: Deduplicate the incoming email list once per heartbeat tick.
triggers: [heartbeat]
required_integrations: []
required_vault_accounts: []
required_functions: [dedupe-emails]
entry_node: node-trigger
---

# When to use this routine

Run this when you have a periodic stream of email addresses from any upstream
source (a CRM dump, an API poll, a webhook buffer) and you need a cleaned,
unique list emitted on every heartbeat tick.

The routine is stateless — it does not remember previously-seen addresses
across runs. Each tick dedupes the current input in isolation.

# Preconditions

- The `dedupe-emails` function must be installed at `~/sulla/functions/dedupe-emails/`.
- The upstream producing `{{ trigger.emails }}` must be wired up before the
  first run. Without it, the trigger fires with an empty list and the
  response is an empty list — no error, just a no-op.

# Success

The routine's response node emits `{{ node-dedupe.output.unique }}`, which
is the input list with exact-match duplicates removed (case-sensitive). Order
is preserved — first occurrence wins.

# Common failure modes

- `python-runtime` container not running → function node fails with a
  connection error to `http://127.0.0.1:30118/invoke`. Start the runtime.
- `~/sulla/functions/dedupe-emails/` missing → function node fails to load.
  Install the function bundle first.
- Malformed input (`emails` not a list of strings) → function returns an
  error payload; the response node emits it unchanged.
