// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const userData = mkdtempSync(path.join(tmpdir(), 'sulla-first-run-trace-registration-'));

vi.mock('electron', () => {
  const app = { getPath: () => userData };
  return { default: { app }, app };
});
vi.mock('@pkg/utils/logging', () => ({ default: { 'first-run': { log: () => undefined } } }));

import { firstRunTraceSink, FirstRunTraceRegistry, firstRunTrace as sinkFirstRunTrace } from '@pkg/utils/firstRunTraceSink';

import { firstRunTrace } from './firstRun/firstRunTrace';

describe('Desktop main first-run trace sink registration', () => {
  it('registers the real first-run timeline on import so agent-side traces reach first-run-trace.log', () => {
    // risk: if registration never runs, every first-run trace in Desktop is silently dropped and support loses the timeline.
    expect(firstRunTraceSink.resolve().trace).toBe(firstRunTrace);
  });

  it('writes a trace through the sink to first-run-trace.log in userData', () => {
    // risk: a registered sink that drops or reroutes lines would change the first-run timeline support reads.
    sinkFirstRunTrace('registration', 'sink wiring check', { providerId: 'codex', status: 'info' });
    const line = readFileSync(path.join(userData, 'first-run-trace.log'), 'utf8').trim().split('\n').at(-1) ?? '';
    expect(line).toContain('\tstep=sink wiring check\t');
    expect(line).toContain('\tprovider=codex\t');
  });

  it('drops traces without a registered sink instead of throwing', () => {
    // risk: a container with no Desktop sink must not break the agent code that records traces.
    const registry = new FirstRunTraceRegistry();
    expect(() => registry.resolve().trace('container', 'no sink registered')).not.toThrow();
  });

  it('is imported by the Electron main entry before any agent code loads', () => {
    // risk: a lazy or indirect-only load leaves the sink unregistered until some other module happens to import it.
    const entry = readFileSync(new URL('../../../background.ts', import.meta.url), 'utf8');
    expect(entry).toContain("import '@pkg/main/firstRun/firstRunTrace';");
  });
});
