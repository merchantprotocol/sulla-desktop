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

// risk: data loss — a failed or unconfirmed log write must survive localStorage and database reload as the full inline result.
it('keeps an unconfirmed large result inline in both saved copies and after reload', () => {
  const threadId = asThreadId('thread-unconfirmed-payload');
  const result = `FULL_INLINE_RESULT:${ 'x'.repeat(180_000) }:END`;
  const state = {
    thread: {
      id: threadId,
      messages: [{ id: asMessageId('123_tool_unconfirmed-call'), kind: 'tool', createdAt: 1, tool: 'Exec', status: 'ok', output: result }],
    },
  } as unknown as ThreadState;

  const persister = new LocalStoragePersister();
  persister.save(state);

  const cached = persister.load(threadId)!;
  const browserTool = cached.thread.messages[0] as any;
  const dbSave = vi.mocked(ipcRenderer.invoke).mock.calls.find(([channel]) => channel === 'chat-messages:save')?.[2] as ThreadState;
  const databaseTool = dbSave.thread.messages[0] as any;
  for (const tool of [browserTool, databaseTool]) {
    expect(tool.output).toBe(result);
    expect(tool).not.toHaveProperty('toolPayloadRef');
  }
});
