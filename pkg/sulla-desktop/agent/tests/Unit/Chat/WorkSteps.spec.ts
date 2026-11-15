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
      .toMatchObject({ title: 'github merge_pr', detail: '' });
    expect(summariseCommand('sulla github/check_runs \'{"repo":"ripple-receptionist-worker","sha":"aefaf0d6bb…')).toMatchObject({ title: 'github check_runs', detail: 'ripple-receptionist-worker' });
    expect(summariseCommand('cd /mnt/data/workspace && git status --short')).toMatchObject({ title: 'git status' });
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

describe('a shell command is named by what it runs', () => {
  // risk: lines titled "cd", "for" or "echo" told the reader nothing
  it('skips setup steps and loop keywords', () => {
    expect(summariseCommand('cd /mnt/data/workspace && git status --short').title).toBe('git status');
    expect(summariseCommand('for p in 4334 4339; do gh pr view $p --json state; done').title).toBe('gh pr');
    expect(summariseCommand('echo "---"; python3 /tmp/audit.py --realm 1').title).toBe('python3 audit.py');
    expect(summariseCommand('FOO=1 npm run build').title).toBe('npm run');
    expect(summariseCommand('cd /x && echo done').title).toBe('shell');
  });

  // risk: finished blocks were titled "Thinking…", the log's placeholder first line
  it('ignores a summary that is only a placeholder or a command', () => {
    const steps = workSteps([thinking(['$ cd /r && git status'])]);
    expect(workTitle(steps, true, 'Thinking...')).toEqual({ lead: 'Ran 1 step', rest: 'git status' });
    expect(workTitle(steps, true, 'Thinking…')).toEqual({ lead: 'Ran 1 step', rest: 'git status' });
    expect(workTitle(steps, true, '$ cd /r && git status').lead).toBe('Ran 1 step');
    expect(workTitle(steps, true, '💭 Checking the merge gate first.').lead).toBe('Checking the merge gate first.');
  });
});
