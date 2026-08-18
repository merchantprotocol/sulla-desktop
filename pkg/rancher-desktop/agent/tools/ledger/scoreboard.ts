import * as fs from 'fs';
import * as path from 'path';

import { BaseTool, ToolResponse } from '../base';
import { resolveSullaLedgerDir } from '../../utils/sullaPaths';

/**
 * Ledger Scoreboard — deterministic, zero-LLM read of the outcome ledger.
 *
 * Counts what the operator actually shipped (OUTCOMES.md dated lines),
 * what is in motion and what is staged at a gate (LEDGER.md WORKING rows),
 * unilateral actions logged (AUDIT.md), and flags staleness against the
 * ledger's own 7-day rule. The heartbeat reads this each cycle and the
 * human reads it as the trust-ratchet evidence — measured, not vibes.
 */

const DATE_LINE = /^-\s*(\d{4}-\d{2}-\d{2})(?:\s+[^—\n]+)?\s*—/;

export function countDatedLines(file: string, sinceDays: number): { total: number; recent: number; newestDate: string | null } {
  let total = 0; let recent = 0; let newestDate: string | null = null;
  const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;

  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
      const m = line.match(DATE_LINE);
      if (!m) continue;
      total += 1;
      const t = new Date(m[1]).getTime();
      if (!Number.isNaN(t) && t >= cutoff) recent += 1;
      if (!newestDate || m[1] > newestDate) newestDate = m[1];
    }
  } catch { /* missing file → zeros */ }

  return { total, recent, newestDate };
}

function countWorkingRows(ledgerFile: string): { working: number; staged: number } {
  let working = 0; let staged = 0;

  try {
    const text = fs.readFileSync(ledgerFile, 'utf8');
    let inWorking = false;
    for (const line of text.split('\n')) {
      if (/^##\s/.test(line)) inWorking = /^##\s+WORKING/i.test(line);
      if (!inWorking) continue;
      // Table data rows only — skip headers and separator rows.
      if (/^\|/.test(line) && !/^\|\s*(Item|Decision|---)/.test(line) && !/^\|[-\s|]+\|$/.test(line)) {
        working += 1;
        if (/gate|staged/i.test(line)) staged += 1;
      }
    }
  } catch { /* missing file → zeros */ }

  return { working, staged };
}

export class LedgerScoreboardWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const days = Number(input?.days) || 7;
    const dir = resolveSullaLedgerDir();

    if (!fs.existsSync(dir)) {
      return {
        successBoolean: true,
        responseString: `No ledger found at ${ dir } — it is scaffolded at app boot; nothing to score yet.`,
      };
    }

    const outcomes = countDatedLines(path.join(dir, 'OUTCOMES.md'), days);
    const audit = countDatedLines(path.join(dir, 'AUDIT.md'), days);
    const { working, staged } = countWorkingRows(path.join(dir, 'LEDGER.md'));

    const staleWarning = outcomes.newestDate &&
      (Date.now() - new Date(outcomes.newestDate).getTime()) > 7 * 24 * 60 * 60 * 1000
      ? `\n⚠️ No outcome recorded in over 7 days (newest: ${ outcomes.newestDate }) — the 7-day rule says review WORKING items now.`
      : '';

    return {
      successBoolean: true,
      responseString: [
        `# Ledger Scoreboard (last ${ days } day(s))`,
        '',
        `- Outcomes shipped: ${ outcomes.recent } (all-time recorded: ${ outcomes.total }, newest: ${ outcomes.newestDate ?? 'none' })`,
        `- WORKING items: ${ working } (${ staged } staged at a gate)`,
        `- Unilateral actions logged: ${ audit.recent } (all-time: ${ audit.total })`,
        staleWarning,
      ].filter(Boolean).join('\n'),
    };
  }
}
