// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { returnCoveredByCard } from '@pkg/pages/chat/messages/handoffCover';
import { idTime, lineTimes, shortTime } from '@pkg/pages/chat/messages/lineTime';
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

describe('the real time of a saved line', () => {
  // risk: older saves dated lines by when the window first saw them, often a restart
  it('comes from the backend id when it carries one', () => {
    expect(idTime('1794757208708_ws_sub_agent_exchange_job', now + 10 ** 12)).toBe(1794757208708);
    expect(idTime('thinking-group:1794757208708_ws_thinking', now + 10 ** 12)).toBe(1794757208708);
    expect(idTime('restored_abc')).toBeUndefined();
  });
});

describe('lines that are not shown', () => {
  // risk: a hidden "Returned from" line took the minute, so the line below showed no time
  it('a return covered by a result card is hidden; a send never is', () => {
    const card = { id: 'c', kind: 'proactive', createdAt: 0, result: { items: [{ jobId: 'job-1', taskIndex: 0 }] } } as any;
    const back = { id: 'r', kind: 'subagent_exchange', createdAt: 0, direction: 'from_agent', jobId: 'job-1', taskIndex: 0 } as any;
    expect(returnCoveredByCard(back, [back, card])).toBe(true);
    expect(returnCoveredByCard({ ...back, direction: 'to_agent' }, [back, card])).toBe(false);
    expect(returnCoveredByCard(back, [back])).toBe(false);
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

describe('the problem a blocked card names', () => {
  // risk: the card quoted Sulla's container-recovery note as the reason an agent was blocked
  it('is the agent\'s own words, never Sulla\'s housekeeping note', async() => {
    const { findProblem, isSystemNote } = await import('@pkg/shared/agentResults/AgentResultCard');
    const report = [
      'Reviewed #4352 against the pinned head.',
      '[BLOCKED] Desktop is offline.',
      '[Container recovery] Guest workspace retained at /mnt/data/sulla/runtime/conversations/abc/workspace.',
      'workspace retained because its cleanup state could not be inspected safely',
    ].join('\n');

    expect(findProblem(report)).toBe('Desktop is offline.');
    expect(isSystemNote('[Container recovery] Guest workspace retained')).toBe(true);
    expect(isSystemNote('[BLOCKED] Desktop is offline.')).toBe(false);
  });
});
