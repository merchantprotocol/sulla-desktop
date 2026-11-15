// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { WorkSteps } from '@pkg/pages/chat/messages/workSteps';

const thinking = (thoughts: string[], extra: Record<string, unknown> = {}): any => ({ id: 't1', kind: 'thinking', createdAt: 0, startedAt: 0, completed: true, thoughts, ...extra });

describe('a work log reads as steps', () => {
  // risk: every command was followed by "Running a shell command" and printed as raw JSON
  it('drops filler lines and summarises each command', () => {
    const steps = WorkSteps.workSteps([thinking([
      '💭 Both verdicts approve; confirm checks before merging.',
      'Running a shell command',
      '$ sulla github/get_pr \'{"owner":"dataripple-org","repo":"ripple-receptionist-worker","pull_number":4334}\'',
      'Running a shell command',
      '$ sulla github/merge_pr \'{"owner":"dataripple-org","repo":"ripple-receptionist-worker","pull_number":4334,"merge_method":"merge","sha":"aefaf0d6bb0eecdab35ceabf6485f16b12cbd0e2"}\'',
    ])]);

    expect(steps.map(step => step.kind)).toEqual(['think', 'run', 'run']);
    expect(steps[1]).toMatchObject({ title: 'GitHub · read PR', detail: 'ripple-receptionist-worker #4334' });
    expect(steps[2]).toMatchObject({ title: 'GitHub · merge PR', detail: 'ripple-receptionist-worker #4334 · aefaf0d' });
    expect((steps[2] as any).raw).toContain('"merge_method":"merge"');
  });

  it('still reads a command the activity line cut off mid-JSON', () => {
    expect(WorkSteps.summariseCommand('sulla github/merge_pr \'{"owner":"dataripple-org","repo":"ripple-receptionist-'))
      .toMatchObject({ title: 'GitHub · merge PR', detail: '' });
    expect(WorkSteps.summariseCommand('sulla github/check_runs \'{"repo":"ripple-receptionist-worker","sha":"aefaf0d6bb…')).toMatchObject({ title: 'GitHub · CI checks', detail: 'ripple-receptionist-worker' });
    expect(WorkSteps.summariseCommand('cd /mnt/data/workspace && git status --short')).toMatchObject({ title: 'git status' });
  });
});

describe('the one-line title', () => {
  const steps = WorkSteps.workSteps([thinking([
    '$ sulla github/get_pr \'{"repo":"r","pull_number":1}\'',
    '$ sulla github/check_runs \'{"repo":"r","sha":"abc1234"}\'',
    '$ sulla github/merge_pr \'{"repo":"r","pull_number":1}\'',
  ])]);

  it('says what it is doing now while live', () => {
    expect(WorkSteps.workTitle(steps, false)).toEqual({ lead: 'GitHub · merge PR', rest: 'r #1' });
  });

  it('uses Sulla\'s own summary when finished, else the commands it ran', () => {
    expect(WorkSteps.workTitle(steps, true, 'Checked and merged #1')).toEqual({ lead: 'Checked and merged #1', rest: 'read PR, CI checks, merge PR' });
    expect(WorkSteps.workTitle(steps, true)).toEqual({ lead: 'Ran 3 steps', rest: 'read PR, CI checks, merge PR' });
    expect(WorkSteps.workTitle(WorkSteps.workSteps([thinking(['💭 Looking at the scope card first.'])]), true)).toEqual({ lead: 'Thought it through', rest: 'Looking at the scope card first.' });
  });
});

describe('a shell command is named by what it runs', () => {
  // risk: lines titled "cd", "for" or "echo" told the reader nothing
  it('skips setup steps and loop keywords', () => {
    expect(WorkSteps.summariseCommand('cd /mnt/data/workspace && git status --short').title).toBe('git status');
    expect(WorkSteps.summariseCommand('for p in 4334 4339; do gh pr view $p --json state; done').title).toBe('gh pr');
    expect(WorkSteps.summariseCommand('echo "---"; python3 /tmp/audit.py --realm 1').title).toBe('python3 audit.py');
    expect(WorkSteps.summariseCommand('FOO=1 npm run build').title).toBe('npm run');
    expect(WorkSteps.summariseCommand('cd /x && echo done').title).toBe('shell');
    // risk: "timeout" read like an error; it only limits how long the real command may run
    expect(WorkSteps.summariseCommand('timeout 60 sulla agents/send_job_message \'{"jobId":"agent-job-1794764276776-7"}\'').title).toBe('Agents · message agent');
    // risk: internal tool names (check_runs, send_job_message) read like code
    expect(WorkSteps.summariseCommand('sulla github/some_new_tool').title).toBe('GitHub · some new tool');
    expect(WorkSteps.summariseCommand('nice -n 10 timeout 5m pnpm test').title).toBe('pnpm test');
  });

  // risk: finished blocks were titled "Thinking…", the log's placeholder first line
  it('ignores a summary that is only a placeholder or a command', () => {
    const steps = WorkSteps.workSteps([thinking(['$ cd /r && git status'])]);
    expect(WorkSteps.workTitle(steps, true, 'Thinking...')).toEqual({ lead: 'Ran 1 step', rest: 'git status' });
    expect(WorkSteps.workTitle(steps, true, 'Thinking…')).toEqual({ lead: 'Ran 1 step', rest: 'git status' });
    expect(WorkSteps.workTitle(steps, true, '$ cd /r && git status').lead).toBe('Ran 1 step');
    expect(WorkSteps.workTitle(steps, true, '💭 Checking the merge gate first.').lead).toBe('Checking the merge gate first.');
  });
});

describe('Sulla tools inside loops and agents\' words read plainly', () => {
  it('a loop around a timed-out Sulla tool is titled by the tool, not "timeout"', () => {
    expect(WorkSteps.summariseCommand('for n in 4352; do timeout 60 sulla github/get_pr \'{"pull_number":4352}\'; done')).toMatchObject({ title: 'GitHub · read PR', short: 'read PR' });
    expect(WorkSteps.summariseCommand('for p in 1 2; do timeout 30 gh pr view $p; done').title).toBe('gh pr');
  });
  it('an agent naming Sulla\'s tools reads as the action', () => {
    expect(WorkSteps.plainToolNames('sulla github/git_push and git_fetch fail')).toBe('GitHub push and fetch fail');
    expect(WorkSteps.plainToolNames('the user_seats table')).toBe('the user_seats table');
    // risk: a lane read "Agents/return result failed…"
    expect(WorkSteps.plainToolNames('Agents/return_result failed; retrying')).toBe('Agents return result failed; retrying');
  });
});

describe('review verdict codes read as words', () => {
  it('an outcome quoting GitHub\'s verdict does not show the API constant', () => {
    expect(WorkSteps.plainToolNames('verdict CHANGES_REQUESTED, for the gap')).toBe('verdict changes requested, for the gap');
  });
});

describe('a shell step\'s detail', () => {
  // risk: a live block read "shell · cd /mnt/data/sulla/runtime/conversations/2a2adf720e26f71b68de1266fd018c75 && …"
  it('does not show Sulla\'s internal folders or full ids', () => {
    const { detail } = WorkSteps.summariseCommand('cd /mnt/data/sulla/runtime/conversations/2a2adf720e26f71b68de1266fd018c75 && ls reports/out.json');
    expect(detail).toBe('cd …/chat folder && ls reports/out.json');
    expect(WorkSteps.summariseCommand('cat /mnt/data/sulla/runtime/conversations/2a2adf720e26f71b68de1266fd018c75/plan.md').detail).toBe('cat …/plan.md');
  });
});
