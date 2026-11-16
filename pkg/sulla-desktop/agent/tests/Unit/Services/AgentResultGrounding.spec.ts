// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { AgentResultGrounding } from '@pkg/agent/services/agentResults/AgentResultGrounding';
import type { AgentResultItem } from '@pkg/shared/agentResults/AgentResultCard';

const report = 'Merged #4320 -> 70c870f2ab (pre 84468d9) and #4315 -> ea0d945. Staging CD (tip of main) on ea0d945: success. ' +
  'See https://github.com/dataripple-org/ripple-receptionist-worker/pull/4315. Fixed qbo/oauth.ts:212.';
const base: AgentResultItem = {
  jobId:     'j',
  taskIndex: 0,
  label:     'Merge train',
  status:    'completed',
  purpose:   'merge',
  verdict:   'Merged',
  tone:      'ok',
  outcome:   'All merged.',
  report,
};

describe('a result card only shows identifiers the agent actually reported', () => {
  // risk: a model summarising the report invents a PR number or commit SHA,
  // and the card presents it as fact next to a revert command
  it('drops a PR or SHA the report never mentions and keeps the real ones', () => {
    const card = new AgentResultGrounding().ground({
      ...base,
      merges: [
        { pr: '#4320', sha: '70c870f2ab' },
        { pr: '4315', sha: 'ea0d945' },
        { pr: '#9999', sha: 'deadbee' },
        { pr: '#4320', sha: 'abc1234' },
      ],
    });

    expect(card.merges).toEqual([
      { pr: '#4320', sha: '70c870f' },
      { pr: '#4315', sha: 'ea0d945' },
      { pr: '#4320', sha: undefined },
    ]);
  });

  it('takes links from the report only, with readable labels', () => {
    const card = new AgentResultGrounding().ground({ ...base, links: [{ label: 'made up', url: 'https://evil.example/x' }] });

    expect(card.links).toEqual([{ label: 'PR #4315', url: 'https://github.com/dataripple-org/ripple-receptionist-worker/pull/4315' }]);
  });

  it('keeps a finding file reference only when that file is in the report', () => {
    const card = new AgentResultGrounding().ground({
      ...base,
      purpose:  'review',
      findings: [
        { severity: 'blocking', title: 'Token refresh', file: 'qbo/oauth.ts:212' },
        { severity: 'minor', title: 'Wording', file: 'qbo/imaginary.ts:3' },
      ],
    });

    expect(card.findings?.map(finding => finding.file)).toEqual(['qbo/oauth.ts:212', undefined]);
  });
});
