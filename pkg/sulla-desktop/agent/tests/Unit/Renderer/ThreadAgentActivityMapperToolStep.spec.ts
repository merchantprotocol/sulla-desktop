// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: vi.fn(async() => ({ success: false })) } }));
import { DetailedTraceProjection } from '@pkg/pages/chat/components/transcript/DetailedTraceProjection';
import { ThreadAgentActivityMapper } from '@pkg/pages/chat/composables/ThreadAgentActivityMapper';
import type { Message } from '@pkg/pages/chat/models/Message';
import { asMessageId } from '@pkg/pages/chat/types/chat';

describe('ThreadAgentActivityMapper tool steps', () => {
  it('uses the persisted safe label and start time for the Standard activity item', () => {
    // risk: privacy and data accuracy — Standard must not expose a shell command and must time from the backend start.
    const rawCommand = 'git status --short -- /private/user/project';
    const tool = {
      id: asMessageId('tool-step'), kind: 'tool', createdAt: 9_000, tool: 'Bash', recordedToolName: 'exec',
      desc: `Running ${rawCommand}`, status: 'running', input: JSON.stringify({ command: rawCommand }),
      meta: { step: { stepId: 'step-1', runId: 'run-1', provider: 'codex', source: 'codex_cli',
        safeLabel: 'git', startedAt: 1_000 } },
    } satisfies Message;
    const mapper = new ThreadAgentActivityMapper(new DetailedTraceProjection());

    const [item] = mapper.primaryTrace([tool], 'thread-1', 'Sulla', 10_000);

    expect(item).toMatchObject({ text: 'git', observedAt: 1_000, phase: 'start', correlationId: 'primary:thread-1:tool-step' });
    expect(JSON.stringify(item)).not.toContain(rawCommand);
  });
});
