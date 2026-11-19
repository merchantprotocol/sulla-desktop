// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, it } from 'vitest';

import { ResultOutcome } from '@pkg/pages/chat/messages/resultOutcome';
const item = (extra: any = {}): any => ({ status: 'completed', verdict: 'Done', purpose: 'fix', outcome: '', ...extra });
it('distinguishes a returned worker from its actual reported outcome without reading negations as success', () => {
  expect(ResultOutcome.label(item({ outcome: 'No changes were committed' }))).toBe('Result returned');
  expect(ResultOutcome.label(item({ purpose: 'review', outcome: 'The previous CHANGES_REQUESTED is now resolved' }))).toBe('Result returned');
  expect(ResultOutcome.label(item({ outcome: 'Fixed and pushed PR #4366 fixtures at e6aad6c.' }))).toBe('Branch updated');
  expect(ResultOutcome.label(item({ purpose: 'review', outcome: 'Confirm review of #4376 at head 13ab160: CHANGES_REQUESTED.' }))).toBe('Changes requested');
  expect(ResultOutcome.label(item({ purpose: 'qa', outcome: 'Run10 completed with 7 Pass / 0 Fail / 2 Blocked, not a full release pass.' }))).toBe('QA incomplete');
  expect(ResultOutcome.label(item({ outcome: 'Fixed and pushed PR #1', merges: [{ pr: '#1' }] }))).toBe('Reported merge');
  expect(ResultOutcome.label(item({ status: 'stopped', merges: [{ pr: '#1' }] }))).toBe('Stopped');
});
it('never fabricates or formats an invalid report time', () => {
  for (const endedAt of [undefined, -1, NaN, Infinity, 1e100]) expect(ResultOutcome.time(item({ endedAt }))).toBe(0);
  expect(ResultOutcome.time(item({ endedAt: 1234 }))).toBe(1234);
});
