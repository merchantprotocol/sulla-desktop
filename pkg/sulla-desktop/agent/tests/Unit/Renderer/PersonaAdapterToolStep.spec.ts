// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { PersonaAdapter } from '@pkg/pages/chat/services/PersonaAdapter';

const { logger } = vi.hoisted(() => ({ logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('electron', () => {
  const ipcRenderer = { invoke: vi.fn(), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
  return { ipcRenderer, default: { ipcRenderer } };
});
vi.mock('@pkg/utils/logging', () => ({
  default: new Proxy({}, { get: () => ({ log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), stream: { write: vi.fn() } }) }),
}));
vi.mock('@pkg/agent/services/SullaLogger', () => ({ SullaLogger: { topic: () => logger } }));

describe('PersonaAdapter tool-step mapping', () => {
  it('persists the backend step contract on the transcript tool row', () => {
    // risk: data accuracy — reloadable history must retain step timestamps and safe labels from the backend card.
    const adapter = Object.create(PersonaAdapter.prototype) as any;
    adapter.firstSeenAt = new Map();
    const meta = { step: { stepId: 'step-1', runId: 'run-1', provider: 'codex', source: 'codex_cli',
      safeLabel: 'git', startedAt: 1_000, endedAt: 2_000, durationMs: 1_000, ok: true } };

    const mapped = adapter.mapBackendMessage({ id: '1_tool_git', kind: 'tool', role: 'assistant', toolCard: {
      toolName: 'exec', label: 'Bash', summary: 'Running command', status: 'success', args: { command: 'git status --short' }, meta,
    } });

    expect(mapped).toMatchObject({ kind: 'tool', status: 'ok', meta });
  });
});
