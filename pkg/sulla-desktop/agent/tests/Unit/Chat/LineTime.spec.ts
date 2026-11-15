// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { lineTimes, shortTime } from '@pkg/pages/chat/messages/lineTime';
import { reportTail } from '@pkg/shared/agentResults/AgentResultCard';

const now = new Date(2026, 10, 15, 14, 40).getTime();
const at = (h: number, m: number, s = 0, day = 15) => new Date(2026, 10, day, h, m, s).getTime();

describe('when each transcript line happened', () => {
  // risk: blocks, handoffs and result cards carried no date or time at all
  it('labels each line, once per minute, with the date before today', () => {
    const times = lineTimes([
      { id: 'a', at: at(14, 28, 5) },
      { id: 'b', at: at(14, 28, 40) },
      { id: 'c', at: at(14, 31) },
      { id: 'old', at: at(9, 5, 0, 14) },
    ], now);

    expect(times.get('a')!.label).toBe(shortTime(at(14, 28), now));
    expect(times.get('b')!.label).toBe('');
    expect(times.get('b')!.full).not.toBe('');
    expect(times.get('c')!.label).toBe(shortTime(at(14, 31), now));
    expect(times.get('old')!.label).toMatch(/Nov 14/);
  });
});

describe('the end of an agent report', () => {
  // risk: the card's preview showed "}" lines and Sulla's container-recovery note
  it('leaves out closing braces and Sulla housekeeping notes', () => {
    const report = [
      '{',
      '"comment": "## Astra review APPROVED"',
      '}',
      '}',
      '[Container recovery] Guest workspace retained at',
      '/mnt/data/sulla/runtime/conversations/abc/workspace.',
      'workspace retained because its cleanup state could not be inspected safely',
    ].join('\n');

    expect(reportTail(report, 'Done')).toEqual(['"comment": "## Astra review APPROVED"']);
  });
});
