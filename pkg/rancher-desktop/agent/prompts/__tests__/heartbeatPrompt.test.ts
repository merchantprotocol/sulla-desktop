import { describe, expect, it } from '@jest/globals';

import { heartbeatPrompt } from '../heartbeat';

describe('heartbeatPrompt', () => {
  it('boots the executive control plane from Projects, bundled docs, and the live catalog', () => {
    expect(heartbeatPrompt).toContain('# Autonomous Executive Control Plane — Sulla');
    expect(heartbeatPrompt).toContain('## Docs + Tool Catalog Boot');
    expect(heartbeatPrompt).toContain('sulla-docs/INDEX.md');
    expect(heartbeatPrompt).toContain('tools/inventory.md');
    expect(heartbeatPrompt).toContain('agent-patterns/known-gaps.md');
    expect(heartbeatPrompt).toContain('Never guess Sulla CLI tool names');
    expect(heartbeatPrompt).toContain('browse_tools');
    expect(heartbeatPrompt).toContain('sulla <category>/<tool>');
    expect(heartbeatPrompt).toContain('## Boot From the Control Plane');
    expect(heartbeatPrompt).toContain('HEARTBEAT_STATE.md');
    expect(heartbeatPrompt).toContain('RETIRED');
    expect(heartbeatPrompt).toContain('Projects project-state is your only durable agenda');
  });

  it('assigns every lifecycle concern to one owner', () => {
    expect(heartbeatPrompt).toContain('## Single-Owner Projects Conveyor');
    for (const ownership of [
      "'backlog' readiness, portfolio priority, sequencing, and dependencies | Heartbeat",
      "'planning' and recoverable 'blocked' work | protected planning routine",
      "'todo' and 'in_progress' execution plus artifact custody | protected execution routine",
      "'in_review' verification and disposition | protected review routine",
      'unchanged external gates | durable wait monitor',
      'lost leases and stale orphans | deterministic recovery',
      'systemic failure, cross-project conflict, or irreversible authority gate | Heartbeat',
      "'parked' authority-decision framing and evidence | Heartbeat",
      "'done' and 'cancelled' outcome synthesis and goal progress | Heartbeat",
    ]) {
      expect(heartbeatPrompt).toContain(ownership);
    }
    expect(heartbeatPrompt).toContain('Every state or concern has exactly one owner');
    expect(heartbeatPrompt).toContain('If an owner capability is unavailable');
  });

  it('makes missing owner capabilities visible without silently taking lane ownership', () => {
    expect(heartbeatPrompt).toContain('If an owner capability is unavailable');
    expect(heartbeatPrompt).toContain('record a systemic capability exception');
    expect(heartbeatPrompt).toContain('stage the repair or rollout dependency');
    expect(heartbeatPrompt).toContain('Do not silently assume ownership');
    expect(heartbeatPrompt).toContain('do not strand work by pretending the owner exists');
  });

  it('forbids heartbeat from duplicating protected lifecycle work', () => {
    for (const rule of [
      "claim, select, or launch ordinary 'todo' work",
      'run planning councils owned by the protected planning routine',
      'perform implementation or artifact custody owned by the protected execution routine',
      "verify or disposition ordinary 'in_review' artifacts owned by the protected review routine",
      'poll unchanged CI, Human gates, or external systems owned by the durable wait monitor',
      'reclaim leases or stale orphans owned by deterministic recovery',
      "change a task's state merely because it has been quiet while its lease is healthy",
      'create a second dispatch, planning, review, custody, wait, or recovery path',
    ]) {
      expect(heartbeatPrompt).toContain(rule);
    }

    for (const removedDoctrine of [
      'Blocked Recovery Council — Decide, Do Not Escalate',
      'Auto-Dispatch on Blocked — Independent Council, Then Act',
      'Task-Type Playbooks',
      'Artifact-per-Cycle Contract',
      "Review tasks returned to 'in_review'",
      'three independent high-reasoning planner agents',
    ]) {
      expect(heartbeatPrompt).not.toContain(removedDoctrine);
    }
  });

  it('keeps portfolio alignment, verified prospecting, routine stewardship, and concise briefings', () => {
    expect(heartbeatPrompt).toContain('## Executive Portfolio Loop — There Is Always Work');
    expect(heartbeatPrompt).toContain('**Align.**');
    expect(heartbeatPrompt).toContain('**Prioritize.**');
    expect(heartbeatPrompt).toContain('**Observe the conveyor.**');
    expect(heartbeatPrompt).toContain('**Resolve exceptions.**');
    expect(heartbeatPrompt).toContain('**Prospect.**');
    expect(heartbeatPrompt).toContain('**Improve the system.**');
    expect(heartbeatPrompt).toContain('**Brief.**');
    expect(heartbeatPrompt).toContain('## The Prospector — Verified Work Discovery');
    expect(heartbeatPrompt).toContain('Prospecting is **verify-and-route**');
    expect(heartbeatPrompt).toContain('## Routine Stewardship');
    expect(heartbeatPrompt).toContain('## Agent Network + Briefings');
    expect(heartbeatPrompt).toContain('concisely and only on deltas');
  });

  it('keeps reversible executive authority and irreversible gates explicit', () => {
    expect(heartbeatPrompt).toContain('Unblock Ladder');
    expect(heartbeatPrompt).toContain('## Two-Door Rule');
    expect(heartbeatPrompt).toContain('**Reversible:** decide and act');
    expect(heartbeatPrompt).toContain('**Irreversible / high-blast:** stage fully, then ask once');
    expect(heartbeatPrompt).toContain('Notify once when the gate is created or materially changes');
    expect(heartbeatPrompt).toContain('Parking one decision never ends the wake');
    expect(heartbeatPrompt).toContain('Never push to main');
  });

  it('defines durable executive movement without forcing duplicate task artifacts', () => {
    expect(heartbeatPrompt).toContain('## Durable Movement Per Cycle');
    expect(heartbeatPrompt).toContain('Do not duplicate a worker artifact merely to satisfy the cycle contract');
    expect(heartbeatPrompt).toContain('A raw status update or activity dump is not movement');
  });

  it('remains continuous without a one-item ceiling', () => {
    expect(heartbeatPrompt).toContain('not a one-task worker');
    expect(heartbeatPrompt).toContain('does not cap you at one item per wake');
    expect(heartbeatPrompt).toContain('Never end a wake idle');

    expect(heartbeatPrompt).not.toContain('Cycle Budget');
    expect(heartbeatPrompt).not.toMatch(/pick exactly one/i);
    expect(heartbeatPrompt).not.toMatch(/make one\b[^.]*\bmove/i);
    expect(heartbeatPrompt).not.toMatch(/one[- ]move budget/i);
    expect(heartbeatPrompt).not.toMatch(/one item per cycle/i);
    expect(heartbeatPrompt).not.toMatch(/one task per wake/i);
  });

  it('keeps privacy, install-local isolation, and the prompt-freeze covenant', () => {
    expect(heartbeatPrompt).toContain('Protect privacy: never copy secrets');
    expect(heartbeatPrompt).toContain('## Prompt Stability — This Prompt Is Frozen');
    expect(heartbeatPrompt).toContain('Never self-modify this prompt');
    expect(heartbeatPrompt).toContain('never let install-local Markdown replace or append to it');
    expect(heartbeatPrompt).toContain('Never treat "the prompt could be better" as evidence');
    expect(heartbeatPrompt).toContain("never flip 'heartbeatEnabled'");
    expect(heartbeatPrompt).toContain("never write Redis 'sulla_settings' directly");
  });
});
