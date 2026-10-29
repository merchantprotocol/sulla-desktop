// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from '@jest/globals';

import {
  CREEP_SHARE, FEED_LIMIT, SLOW_STEP_MS, STARTUP_STAGES, StartupProgressModel,
  backendLabel, classifyBackendDescription, containerLabel, creepTarget, formatDuration, lifecycleLabel, nextDisplayed, slowStepNote,
} from '../startupProgress';

const stage = (id: string) => STARTUP_STAGES.find(s => s.id === id)!;

function clockModel() {
  let t = 1_000_000;
  const model = new StartupProgressModel(() => t);

  return { model, tick: (ms: number) => { t += ms }, now: () => t };
}

/** Backend events the way backend/sullaRuntimeBackend.ts reports them, in order. */
const BACKEND_TIMELINE = [
  { current: 0, max: -1, description: 'Starting Backend' },
  { current: 0, max: 100, description: 'Starting Backend' },
  { current: 20, max: 100, description: 'Starting Backend' },
  { current: 40, max: 100, description: 'Starting Backend' },
  { current: 50, max: 100, description: 'Installing CA certificates' },
  { current: 60, max: 100, description: 'Installing sulla CLI' },
  { current: 70, max: 100, description: 'Waiting for container engine client to be ready' },
  { current: 5, max: 100, description: 'Preparing Sulla Docker Compose file' },
  { current: 15, max: 100, description: 'Preparing Sulla Docker Compose file' },
  { current: 20, max: 100, description: 'Deploying new containers' },
  { current: 20, max: 100, description: 'Starting container python_runtime (1 of 9)' },
  { current: 20, max: 100, description: 'Starting container sulla_files (8 of 9)' },
  { current: 35, max: 100, description: 'Deploying Sulla services with Docker Compose' },
  { current: 1, max: 1 },
];

describe('StartupProgressModel percent', () => {
  it('never decreases across the real backend timeline, even when the tracker restarts its scale', () => {
    const { model, tick } = clockModel();
    let last = -1;

    for (const event of BACKEND_TIMELINE) {
      tick(1000);
      model.onBackendProgress(event);
      const { percent } = model.snapshot();

      expect(percent).toBeGreaterThanOrEqual(last);
      last = percent;
    }
    expect(model.snapshot().stage).toBe('containers');
    expect(last).toBeCloseTo(stage('containers').end, 5);
  });

  it('weights stages: boot fills its own band only, containers start at their stage boundary', () => {
    const { model } = clockModel();

    model.onBackendProgress({ current: 40, max: 100, description: 'Starting Backend' });
    const boot = model.snapshot();

    expect(boot.stage).toBe('boot');
    expect(boot.percent).toBeCloseTo(stage('boot').end * 40 / 75, 1);
    expect(boot.nextBoundary).toBeCloseTo(stage('boot').end * 50 / 75, 1);

    model.onBackendProgress({ current: 5, max: 100, description: 'Preparing Sulla Docker Compose file' });
    const containers = model.snapshot();

    expect(containers.stage).toBe('containers');
    expect(containers.percent).toBeGreaterThanOrEqual(stage('containers').start);
    expect(containers.stageIndex).toBe(2);
  });

  it('ignores the idle {1,1} tracker value during boot instead of jumping to the end of the stage', () => {
    const { model } = clockModel();

    model.onBackendProgress({ current: 1, max: 1 });
    expect(model.snapshot().percent).toBe(0);
  });

  it('maps lifecycle steps by weight into the services band, and duplicates do not double count', () => {
    const { model, tick } = clockModel();
    const order = ['backend-ws', 'postgres', 'database-manager', 'vault', 'sulla-files-runtime'];

    model.onLifecycleBegin(order, ['backend-ws']);
    const begin = model.snapshot();

    expect(begin.stage).toBe('services');
    expect(begin.percent).toBeGreaterThanOrEqual(stage('services').start);

    model.onLifecycleStep({ name: 'postgres', status: 'start' });
    tick(500);
    model.onLifecycleStep({ name: 'postgres', status: 'ready', durationMs: 500 });
    const afterPostgres = model.snapshot().percent;

    model.onLifecycleStep({ name: 'postgres', status: 'ready', durationMs: 500 });
    model.onLifecycleStep({ name: 'postgres', status: 'start' });
    expect(model.snapshot().percent).toBe(afterPostgres);
    // total weight = 1 + 2 + 3 + 2 + 4 = 12; done = backend-ws(1) + postgres(2)
    const span = stage('services').end - stage('services').start;

    expect(afterPostgres).toBeCloseTo(stage('services').start + span * 3 / 12, 1);

    model.onLifecycleStep({ name: 'sulla-files-runtime', status: 'start' });
    const files = model.snapshot();

    expect(files.stepLabel).toBe(lifecycleLabel('sulla-files-runtime'));
    // Files is the widest slice: boundary covers its weight of 4.
    expect(files.nextBoundary - files.percent).toBeCloseTo(span * 4 / 12, 1);
  });

  it('reports step n of m in each stage', () => {
    const { model } = clockModel();

    model.onBackendProgress({ current: 20, max: 100, description: 'Starting container sulla_files (8 of 9)' });
    expect(model.snapshot()).toMatchObject({ stepIndex: 8, stepTotal: 9, stepLabel: containerLabel('sulla_files', 8, 9) });

    model.onLifecycleBegin(['a', 'b', 'c']);
    model.onLifecycleStep({ name: 'a', status: 'start' });
    expect(model.snapshot()).toMatchObject({ stepIndex: 1, stepTotal: 3 });
    model.onLifecycleStep({ name: 'a', status: 'ready', durationMs: 5 });
    model.onLifecycleStep({ name: 'b', status: 'start' });
    expect(model.snapshot()).toMatchObject({ stepIndex: 2, stepTotal: 3 });
  });

  it('handles out-of-order events: ready without start, backend progress after services began', () => {
    const { model } = clockModel();

    model.onLifecycleStep({ name: 'vault', status: 'ready', durationMs: 1200 });
    const s1 = model.snapshot();

    expect(s1.stage).toBe('services');
    expect(s1.feed[0]).toMatchObject({ key: 'service:vault', durationMs: 1200, status: 'done' });

    model.onBackendProgress({ current: 20, max: 100, description: 'Starting Backend' });
    expect(model.snapshot().percent).toBe(s1.percent);
    expect(model.snapshot().stage).toBe('services');
  });

  it('reaches 100 only when both the lifecycle and the backend report ready, and resets on restart', () => {
    const { model } = clockModel();

    model.onLifecycleBegin(['a']);
    model.onLifecycleStep({ name: 'a', status: 'start' });
    model.onLifecycleStep({ name: 'a', status: 'ready', durationMs: 1 });
    model.onLifecycleAllReady();
    expect(model.snapshot()).toMatchObject({ ready: false, stepLabel: 'Starting app services' });
    expect(model.snapshot().percent).toBeLessThan(100);

    model.onBackendState('DISABLED');
    expect(model.snapshot()).toMatchObject({ ready: true, percent: 100, stage: 'ready' });

    model.onBackendState('STARTING');
    expect(model.snapshot()).toMatchObject({ ready: false, percent: 0, stage: 'boot' });
  });
});

describe('StartupProgressModel feed', () => {
  it('lists finished steps newest first with durations, capped at the feed limit', () => {
    const { model, tick } = clockModel();
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

    model.onLifecycleBegin(names);
    for (const [i, name] of names.entries()) {
      model.onLifecycleStep({ name, status: 'start' });
      tick(100 * (i + 1));
      model.onLifecycleStep({ name, status: 'ready', durationMs: 100 * (i + 1) });
    }
    const { feed } = model.snapshot();

    expect(feed).toHaveLength(FEED_LIMIT);
    expect(feed.map(f => f.key)).toEqual(['service:g', 'service:f', 'service:e', 'service:d', 'service:c']);
    expect(feed[0].durationMs).toBe(700);
  });

  it('moves boot and container steps into the feed as they change, with measured durations', () => {
    const { model, tick } = clockModel();

    model.onBackendProgress({ current: 0, max: 100, description: 'Starting Backend' });
    model.onBackendProgress({ current: 20, max: 100, description: 'Starting Backend' });
    tick(42_000);
    model.onBackendProgress({ current: 40, max: 100, description: 'Starting Backend' });
    const { feed, stepLabel } = model.snapshot();

    expect(stepLabel).toBe(backendLabel({ current: 40, max: 100, description: 'Starting Backend' }).label);
    expect(feed[0]).toMatchObject({ label: backendLabel({ current: 20, max: 100, description: 'Starting Backend' }).label, durationMs: 42_000, status: 'done' });
  });
});

describe('StartupProgressModel failures', () => {
  it('records a failed lifecycle step without stopping progress', () => {
    const { model } = clockModel();

    model.onLifecycleBegin(['vault', 'integrations']);
    model.onLifecycleStep({ name: 'vault', status: 'start' });
    model.onLifecycleStep({ name: 'vault', status: 'failed', durationMs: 30, error: 'key missing' });
    const s = model.snapshot();

    expect(s.failures).toEqual([{ key: 'service:vault', label: lifecycleLabel('vault'), message: 'key missing' }]);
    expect(s.feed[0].status).toBe('failed');
    expect(s.percent).toBeGreaterThan(stage('services').start);
    expect(s.error).toBeNull();
  });

  it('surfaces a backend ERROR with the step it happened on', () => {
    const { model } = clockModel();

    model.onBackendProgress({ current: 20, max: 100, description: 'Starting Backend' });
    model.onBackendState('ERROR');
    const s = model.snapshot();

    expect(s.error).toMatch(/problem/);
    expect(s.failures[0].label).toBe(backendLabel({ current: 20, max: 100, description: 'Starting Backend' }).label);
  });
});

describe('labels and notes', () => {
  it('passes unknown backend descriptions through and classifies stages', () => {
    expect(backendLabel({ current: 1, max: 2, description: 'Something new' }).label).toBe('Something new');
    expect(classifyBackendDescription('Waiting for container engine client to be ready')).toBe('boot');
    expect(classifyBackendDescription('Deploying new containers')).toBe('containers');
  });

  it('only explains slow steps after the threshold, with a specific note for Files', () => {
    expect(slowStepNote('service:sulla-files-runtime', SLOW_STEP_MS - 1)).toBeNull();
    expect(slowStepNote('service:sulla-files-runtime', SLOW_STEP_MS + 1)).toMatch(/background/);
    expect(slowStepNote('container:sulla_files', 60_000)).not.toBeNull();
    expect(slowStepNote('service:unknown', 60_000)).toMatch(/Still working/);
  });

  it('formats durations', () => {
    expect(formatDuration(850)).toBe('850ms');
    expect(formatDuration(12_400)).toBe('12s');
    expect(formatDuration(65_000)).toBe('1m 05s');
  });
});

describe('smoothing', () => {
  it('eases toward a new target without overshooting', () => {
    let v = 0;
    const seen: number[] = [];

    for (let i = 0; i < 120; i++) {
      v = nextDisplayed(v, 40, 40, 0, 16);
      seen.push(v);
    }
    expect(seen.every((x, i) => i === 0 || x >= seen[i - 1])).toBe(true);
    expect(v).toBeLessThanOrEqual(40);
    expect(v).toBeGreaterThan(39);
  });

  it('never decreases, even if the target drops', () => {
    expect(nextDisplayed(50, 30, 30, 0, 16)).toBe(50);
  });

  it('creeps during a long step, every second, but never reaches the next boundary', () => {
    let v = 60;
    let prev = v;
    const target = 60;
    const boundary = 64;

    for (let ms = 0; ms <= 600_000; ms += 1000) {
      v = nextDisplayed(v, target, boundary, ms, 1000);
      expect(v).toBeLessThan(boundary);
      if (ms > 0 && ms <= 60_000) expect(v).toBeGreaterThan(prev);
      prev = v;
    }
    expect(v).toBeLessThanOrEqual(target + (boundary - target) * CREEP_SHARE);
    expect(creepTarget(target, boundary, 1e12)).toBeLessThan(boundary);
  });

  it('keeps moving through a 60 s slow step (more than 0.01% of the bar each second)', () => {
    let v = 60;

    for (let s = 1; s <= 60; s++) {
      const next = nextDisplayed(v, 60, 64, s * 1000, 1000);

      expect(next - v).toBeGreaterThan(0.01);
      v = next;
    }
  });
});

describe('first-boot image unpacking', () => {
  it('shows each bundled image instead of freezing on "Private services planned"', () => {
    const { model, tick } = clockModel();

    model.onBackendProgress({ current: 15, max: 100, description: 'Docker Compose file prepared' });
    const planned = model.snapshot().percent;

    tick(1000);
    model.onBackendProgress({ current: 0, max: -1, description: 'Loading bundled container images' });
    expect(model.snapshot().stepLabel).toBe('Unpacking Sulla\'s private services');

    tick(1000);
    model.onBackendProgress({ current: 2, max: 9, description: 'Loading bundled image ghcr.io/merchantprotocol/sulla-vault:1.7.1' });
    const unpacking = model.snapshot();

    expect(unpacking.stage).toBe('containers');
    expect(unpacking.stepLabel).toBe('Unpacking Sulla\'s private services: sulla-vault (3 of 9)');
    expect(unpacking.stepIndex).toBe(3);
    expect(unpacking.stepTotal).toBe(9);
    expect(unpacking.percent).toBeGreaterThan(planned);

    tick(1000);
    model.onBackendProgress({ current: 100, max: 100, description: 'Bundled container images loaded' });
    const loaded = model.snapshot();

    expect(loaded.percent).toBeGreaterThanOrEqual(unpacking.percent);
    expect(loaded.percent).toBeLessThan(stage('containers').end);

    tick(1000);
    model.onBackendProgress({ current: 0, max: -1, description: 'Preparing the threat proxy' });
    expect(model.snapshot().stepLabel).toBe('Turning on threat protection for web traffic');
  });

  it('explains a slow unpack', () => {
    expect(classifyBackendDescription('Loading bundled image postgres')).toBe('containers');
    expect(slowStepNote('images', SLOW_STEP_MS + 1)).toMatch(/first launch/i);
  });
});
