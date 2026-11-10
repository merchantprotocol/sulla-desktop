// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { FleetTaskView } from '../Services/AgentFleetTypes';

/** Extracts a persisted GitHub pull-request URL without doing network work. */
export class PullRequestReferenceExtractor {
  extract(task: FleetTaskView): string | null {
    for (const value of [task.result, task.completion]) {
      const structured = this.structured(value);
      if (structured) return structured;
    }
    return this.fromText([task.latestCheckin?.summary, task.completion].filter(Boolean).map(String).join(' '));
  }

  private structured(value: unknown): string | null {
    if (typeof value === 'string') return this.validated(value);
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    for (const key of ['pr', 'prUrl']) {
      const found = this.validated(record[key]);
      if (found) return found;
    }
    for (const key of ['output', 'result']) {
      const nested = this.structured(record[key]);
      if (nested) return nested;
    }
    return null;
  }

  private fromText(text: string): string | null {
    const match = text.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+(?:\b|\/)/);
    return match ? match[0].replace(/\/$/, '') : null;
  }

  private validated(value: unknown): string | null {
    return typeof value === 'string' ? this.fromText(value) : null;
  }
}
