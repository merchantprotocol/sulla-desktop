// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { summariseCommand, workSteps, workTitle } from '@pkg/pages/chat/messages/workSteps';

const thinking = (thoughts: string[], extra: Record<string, unknown> = {}): any => ({ id: 't1', kind: 'thinking', createdAt: 0, startedAt: 0, completed: true, thoughts, ...extra });

describe('a work log reads as steps', () => {
  // risk: every command was followed by "Running a shell command" and printed as raw JSON
  it('drops filler lines and summarises each command', () => {
    const steps = workSteps([thinking([
      '💭 Both verdicts approve; confirm checks before merging.',
      'Running a shell command',
      '$ sulla github/get_pr \'{"owner":"dataripple-org","repo":"ripple-receptionist-worker","pull_number":4334}\'',
      'Running a shell command',
      '$ sulla github/merge_pr \'{"owner":"dataripple-org","repo":"ripple-receptionist-worker","pull_number":4334,"merge_method":"merge","sha":"aefaf0d6bb0eecdab35ceabf6485f16b12cbd0e2"}\'',
    ])]);

    expect(steps.map(step => step.kind)).toEqual(['think', 'run', 'run']);
    expect(steps[1]).toMatchObject({ title: 'github get_pr', detail: 'ripple-receptionist-worker #4334' });
    expect(steps[2]).toMatchObject({ title: 'github merge_pr', detail: 'ripple-receptionist-worker #4334 · aefaf0d' });
    expect((steps[2] as any).raw).toContain('"merge_method":"merge"');
  });

  it('still reads a command the activity line cut off mid-JSON', () => {
    expect(summariseCommand('sulla github/merge_pr \'{"owner":"dataripple-org","repo":"ripple-receptionist-'))
      .toEqual({ title: 'github merge_pr', detail: '' });
    expect(summariseCommand('sulla github/check_runs \'{"repo":"ripple-receptionist-worker","sha":"aefaf0d6bb…')).toMatchObject({ title: 'github check_runs', detail: 'ripple-receptionist-worker' });
    expect(summariseCommand('cd /mnt/data/workspace && git status --short')).toMatchObject({ title: 'cd' });
  });
});

describe('the one-line title', () => {
  const steps = workSteps([thinking([
    '$ sulla github/get_pr \'{"repo":"r","pull_number":1}\'',
    '$ sulla github/check_runs \'{"repo":"r","sha":"abc1234"}\'',
    '$ sulla github/merge_pr \'{"repo":"r","pull_number":1}\'',
  ])]);

  it('says what it is doing now while live', () => {
    expect(workTitle(steps, false)).toEqual({ lead: 'github merge_pr', rest: 'r #1' });
  });

  it('uses Sulla\'s own summary when finished, else the commands it ran', () => {
    expect(workTitle(steps, true, 'Checked and merged #1')).toEqual({ lead: 'Checked and merged #1', rest: 'get_pr, check_runs, merge_pr' });
    expect(workTitle(steps, true)).toEqual({ lead: 'Ran 3 steps', rest: 'get_pr, check_runs, merge_pr' });
    expect(workTitle(workSteps([thinking(['💭 Looking at the scope card first.'])]), true)).toEqual({ lead: 'Thought it through', rest: 'Looking at the scope card first.' });
  });
});
