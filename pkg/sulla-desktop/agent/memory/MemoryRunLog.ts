// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * One structured line per memory-agent run, so the number of memory agents
 * and model calls per turn is observable from the logs:
 *
 *   [Memory] {"agent":"elephant","phase":"draft","thread":"…","ms":812,"outcome":"drafted"}
 *
 * Expected per completed human turn: elephant draft + goldfish review +
 * (only when the goldfish found gaps) elephant complete, then one write line.
 * Expected per hour: one dreamer line.
 */
export type MemoryAgentName = 'elephant' | 'goldfish' | 'dreamer';

export interface MemoryRunRecord {
  agent:   MemoryAgentName;
  thread:  string;
  ms:      number;
  outcome: string;
  [extra: string]: unknown;
}

export class MemoryRunLog {
  constructor(private readonly sink: (line: string) => void = line => console.log(line)) {}

  record(entry: MemoryRunRecord): void {
    try {
      this.sink(`[Memory] ${ JSON.stringify(entry) }`);
    } catch { /* logging must never break memory writes */ }
  }
}

export const memoryRunLog = new MemoryRunLog();
