// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

// A throwaway "host home": any write to <home>/.claude would land here.
const fakeHome = vi.hoisted(() => {
  const nodeFs = require('node:fs') as typeof import('node:fs');
  const nodeOs = require('node:os') as typeof import('node:os');
  const nodePath = require('node:path') as typeof import('node:path');

  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'sulla-host-home-'));
});

function withHome(actual: typeof import('node:os')) {
  return { ...actual, default: { ...actual, homedir: () => fakeHome }, homedir: () => fakeHome };
}
vi.mock('os', async importOriginal => withHome(await importOriginal<typeof import('node:os')>()));
vi.mock('node:os', async importOriginal => withHome(await importOriginal<typeof import('node:os')>()));

// A real prompt, so a host writer (if one existed) would have content to write.
vi.mock('../../../../prompts/buildFullSystemPrompt', () => ({ buildFullSystemPrompt: vi.fn(() => Promise.resolve('You are Sulla Desktop')) }));

vi.mock('../../../../database/models/ObservationsModel', () => ({
  ObservationsModel: {
    insert:        vi.fn((row: { id: string; priority: string }) => Promise.resolve({ ...row })),
    update:        vi.fn((id: string, row: { priority: string }) => Promise.resolve({ id, ...row })),
    findDuplicate: vi.fn(() => Promise.resolve(null)),
    getById:       vi.fn((id: string) => Promise.resolve({ id, content: 'note' })),
    archive:       vi.fn(() => Promise.resolve(undefined)),
  },
}));

const { AddObservationalMemoryWorker } = await import('../../../../tools/meta/add_observational_memory');
const { RemoveObservationalMemoryWorker } = await import('../../../../tools/meta/remove_observational_memory');

afterAll(() => fs.rmSync(fakeHome, { recursive: true, force: true }));

describe('observational memory and the host home folder', () => {
  // risk: Sulla overwrote the user's personal ~/.claude/CLAUDE.md on every memory write,
  // replacing their own Claude Code rules with Sulla's agent prompt
  it('adding, updating and removing an observation never writes under the host ~/.claude', async() => {
    await (new AddObservationalMemoryWorker() as any)._validatedCall({ priority: '🔴', content: 'User prefers short replies' });
    await (new AddObservationalMemoryWorker() as any)._validatedCall({ id: 'obs1', priority: '🟡', content: 'Updated note' });
    await (new RemoveObservationalMemoryWorker() as any)._validatedCall({ id: 'obs1' });
    // Former writers ran fire-and-forget; give any such write time to land.
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(fs.existsSync(path.join(fakeHome, '.claude'))).toBe(false);
  });
});
