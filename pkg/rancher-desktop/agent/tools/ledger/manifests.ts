import type { ToolManifest } from '../registry';

/**
 * Ledger tools — deterministic reads of the outcome ledger at ~/sulla/ledger/.
 * The ledger itself is maintained by the observation writer (each turn) and
 * the agents directly (via read_file/write_file); these tools provide the
 * zero-LLM measurement layer.
 */
export const ledgerToolManifests: ToolManifest[] = [
  {
    name:        'ledger_scoreboard',
    description: 'Deterministic outcome-ledger scoreboard (zero LLM): outcomes shipped in the window, WORKING items and how many are staged at a gate, unilateral actions logged in AUDIT.md, and a staleness flag against the 7-day rule. The heartbeat reads this each cycle; the human reads it as the trust-ratchet evidence.',
    category:    'ledger',
    schemaDef:   {
      days: { type: 'number', optional: true, description: 'Window in days for the "recent" counts (default 7).' },
    },
    operationTypes: ['read'],
    loader:         () => import('./scoreboard'),
  },
];
