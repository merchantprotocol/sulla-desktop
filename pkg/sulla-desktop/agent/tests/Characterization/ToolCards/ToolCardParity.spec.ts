// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import { describe, expect, it } from 'vitest';
import { formatToolCard, formatToolResult } from '../../../tools/toolCardFormatters';
import cases from './tool-card-parity.json';

describe('tool card legacy parity', () => {
  it('keeps every known exact tool and representative fallback byte-identical', () => {
    // risk: renderer-visible summaries changing during the strategy refactor
    for (const entry of cases) {
      const result = entry.result ?? undefined;
      expect(formatToolCard(entry.name, {}, result), entry.name).toEqual(entry.card);
      expect(formatToolResult(entry.name, {}, result), entry.name).toEqual(entry.output);
    }
  });
});
