import { describe, expect, it } from '@jest/globals';

import { heartbeatPrompt } from '../heartbeat';

describe('heartbeatPrompt', () => {
  it('frames the wake as time to brainstorm and run real experiments', () => {
    expect(heartbeatPrompt).toContain('# Heartbeat — Your Time to Think, Invent, and Try');
    expect(heartbeatPrompt).toContain('A wake that ends with "nothing changed" is a failed wake');
    expect(heartbeatPrompt).toContain('## The Wake Loop — Think, Choose, Try, Learn');
    for (const step of ['**Orient fast.**', '**Brainstorm.**', '**Choose.**', '**Try it for real.**', '**Learn and record.**', '**Go again.**']) {
      expect(heartbeatPrompt).toContain(step);
    }
    expect(heartbeatPrompt).toContain('Write down at least five fresh ideas');
    expect(heartbeatPrompt).toContain('Every idea must differ from what the idea lab already holds');
    expect(heartbeatPrompt).toContain('Thinking about an idea is not trying it');
    expect(heartbeatPrompt).toContain('End the wake only after at least one experiment is recorded and the next one is queued');
  });

  it('keeps a durable idea lab so fresh sessions do not repeat themselves', () => {
    expect(heartbeatPrompt).toContain('## The Idea Lab — Your Memory Between Wakes');
    expect(heartbeatPrompt).toContain("slug 'heartbeat-idea-lab'");
    expect(heartbeatPrompt).toContain("Write with actor 'heartbeat'");
    expect(heartbeatPrompt).toContain('backlog-role lane so no execution routine claims them');
    expect(heartbeatPrompt).toContain('Never move a lab task into the ordered effective execution-entry lane');
    expect(heartbeatPrompt).toContain('ordered effective planning lane');
    expect(heartbeatPrompt).toContain('Read the lab before brainstorming, every wake');
  });

  it('forbids idle and disguised-idle wakes', () => {
    expect(heartbeatPrompt).toContain('## No Idle Wakes');
    expect(heartbeatPrompt).toContain('that is the signal to switch to a new idea, not to hold');
    expect(heartbeatPrompt).toContain('A focus directive from your Human sets priority, not a cage');
    expect(heartbeatPrompt).toContain('protect their attention, not your activity');
    expect(heartbeatPrompt).toContain('idle wakes in disguise');
    expect(heartbeatPrompt).toContain('stagnation alert');
    expect(heartbeatPrompt).toContain('Never brief that nothing changed');
  });

  it('aims ideas at the north star without widening authority', () => {
    expect(heartbeatPrompt).toContain('The Heartbeat Goal section carries the north star for this install');
    expect(heartbeatPrompt).toContain('it outranks your own view of what matters');
    expect(heartbeatPrompt).toContain('The north star never widens your authority');
    expect(heartbeatPrompt).toContain('Hold at most three active goals');
    expect(heartbeatPrompt).toContain('A wake ending is a pause, not a stop');
  });

  it('keeps irreversible actions Human-gated', () => {
    expect(heartbeatPrompt).toContain('## Two-Door Rule');
    expect(heartbeatPrompt).toContain('**Reversible:** decide and act');
    expect(heartbeatPrompt).toContain('**Irreversible / high-blast:** stage fully, then ask once');
    for (const gate of ['Merges to protected branches', 'production deploys', 'spending money', "external communications in your Human's name"]) {
      expect(heartbeatPrompt).toContain(gate);
    }
    expect(heartbeatPrompt).toContain('Never push to main');
    expect(heartbeatPrompt).toContain('Design every experiment to fit the reversible door');
  });

  it('respects the single-owner conveyor', () => {
    expect(heartbeatPrompt).toContain('Projects project-state is your only durable agenda');
    expect(heartbeatPrompt).toContain('HEARTBEAT_STATE.md');
    expect(heartbeatPrompt).toContain('RETIRED');
    expect(heartbeatPrompt).toContain('Every state or concern has exactly one owner');
    for (const ownership of [
      'planning-role and recoverable blocked-role work | protected planning routine',
      'execution-role work plus artifact custody | protected execution routine',
      'review-role verification and disposition | protected review routine',
      'unchanged external gates | durable wait monitor',
      'lost leases and stale orphans | deterministic recovery',
    ]) {
      expect(heartbeatPrompt).toContain(ownership);
    }
    expect(heartbeatPrompt).toContain('create a second dispatch, planning, review, custody, wait, or recovery path');
    expect(heartbeatPrompt).toContain('Never conceal a broken conveyor by manually doing the stranded task');
    expect(heartbeatPrompt).toContain("Resolve every task's effective lane and semantic role");
  });

  it('keeps comments delta-only without teaching silence', () => {
    expect(heartbeatPrompt).toContain('## Comments — Signal, Not Noise');
    expect(heartbeatPrompt).toContain('Never post "still blocked," "still waiting," or "unchanged."');
    expect(heartbeatPrompt).toContain('then go make something new');
    expect(heartbeatPrompt).toContain('One material event gets one concise comment');
    expect(heartbeatPrompt).not.toContain('Delta or Silence');
    expect(heartbeatPrompt).not.toContain('If the state and evidence are unchanged, write nothing');
  });

  it('uses the native catalog and bundled docs', () => {
    expect(heartbeatPrompt).toContain('sulla-docs/INDEX.md');
    expect(heartbeatPrompt).toContain('Never guess Sulla CLI tool names');
    expect(heartbeatPrompt).toContain('browse_tools');
    expect(heartbeatPrompt).toContain('sulla <category>/<tool>');
  });

  it('never reintroduces a one-item ceiling', () => {
    expect(heartbeatPrompt).not.toContain('Cycle Budget');
    expect(heartbeatPrompt).not.toMatch(/pick exactly one/i);
    expect(heartbeatPrompt).not.toMatch(/make one\b[^.]*\bmove/i);
    expect(heartbeatPrompt).not.toMatch(/one item per cycle/i);
  });

  it('keeps privacy and the prompt-freeze covenant', () => {
    expect(heartbeatPrompt).toContain('Protect privacy: never copy secrets');
    expect(heartbeatPrompt).toContain('## Prompt Stability — This Prompt Is Frozen');
    expect(heartbeatPrompt).toContain('Never self-modify it');
    expect(heartbeatPrompt).toContain('never let install-local Markdown replace or append to it');
    expect(heartbeatPrompt).toContain("Never flip 'heartbeatEnabled'");
    expect(heartbeatPrompt).toContain("never write Redis 'sulla_settings' directly");
  });
});
