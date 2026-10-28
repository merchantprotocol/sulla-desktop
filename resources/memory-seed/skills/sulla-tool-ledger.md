---
slug: sulla-tool-ledger
label: Use the Sulla Ledger tools
trigger_when: When you need to use Sulla Ledger operations.
trigger_actions: [ledger, ledger tools]
trigger_phrases: [ledger, ledger]
scope: [tool-ledger]
---

**When:** When you need to use Sulla Ledger operations.

**Do:**
1. Use the exact command and parameters listed below.
2. Read returned state before making a follow-up change.
3. Keep destructive actions behind their required confirmation fields.

**Tools:**

# ledger tools

Outcome-ledger measurement — historical scoreboard of WORKING / OUTCOMES / AUDIT at ~/sulla/ledger/. Files are archive/readout only; Projects project-state is the structured agenda.

## scoreboard

Deterministic outcome-ledger scoreboard (zero LLM): outcomes shipped in the window, WORKING items and how many are staged at a gate, unilateral actions logged in AUDIT.md, and a staleness flag against the 7-day rule. The heartbeat reads this each cycle; the human reads it as the trust-ratchet evidence.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `days` | number | Optional |

**Example**

```bash
sulla ledger/scoreboard '{}'
```


**Don't:**
- Don't invent tool names or parameters; check `sulla meta/browse_tools` when the catalog and source differ.
- Don't expose secrets, tokens, or private data in output.
