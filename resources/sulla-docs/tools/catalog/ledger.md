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
