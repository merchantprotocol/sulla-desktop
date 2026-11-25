// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom

import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: vi.fn(async() => ({ success: true })), send: vi.fn() } }));

import { LocalStoragePersister } from '@pkg/pages/chat/services/LocalStoragePersister';
import type { ThreadState } from '@pkg/pages/chat/models/Thread';
import { asMessageId, asThreadId } from '@pkg/pages/chat/types/chat';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

beforeEach(() => { localStorage.clear(); vi.mocked(ipcRenderer.invoke).mockClear(); });

// risk: performance and data accuracy — full results stay in the durable log, not duplicated into saved thread snapshots.
it('persists a 5 MB tool result as a bounded pointer in both sinks', () => {
  const threadId = asThreadId('thread-large-payload');
  const result = `FULL_RESULT:${ 'x'.repeat(5_000_000) }:END`;
  const state = {
    thread: {
      id: threadId,
      messages: [{ id: asMessageId('123_tool_large-call'), kind: 'tool', createdAt: 1, tool: 'Exec', status: 'ok', output: result }],
    },
  } as unknown as ThreadState;

  new LocalStoragePersister().save(state);

  const cached = JSON.parse(localStorage.getItem(`chat:thread:${ threadId }`)!) as ThreadState;
  const browserTool = cached.thread.messages[0] as any;
  const dbSave = vi.mocked(ipcRenderer.invoke).mock.calls.find(([channel]) => channel === 'chat-messages:save')?.[2] as ThreadState;
  const databaseTool = dbSave.thread.messages[0] as any;
  for (const tool of [browserTool, databaseTool]) {
    expect(tool).toMatchObject({ toolPayloadRef: { threadId, toolRunId: 'large-call' } });
    expect(tool.output).toBeUndefined();
    expect(JSON.stringify(tool).length).toBeLessThan(1_000);
  }
});
