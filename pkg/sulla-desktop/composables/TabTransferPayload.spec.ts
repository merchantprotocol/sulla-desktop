// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { reactive, readonly } from 'vue';

import { TabTransferPayload } from './TabTransferPayload';

import type { BrowserTab } from './useBrowserTabs';

const descriptor = (mode: BrowserTab['mode']): BrowserTab => ({
  id: 'tab', url: 'about:blank', title: 'Tab', favicon: '', loading: false, mode,
});

describe('TabTransferPayload', () => {
  const payload = new TabTransferPayload();

  it('can send nested reactive chat metadata without carrying internal fields', () => {
    const agentChat = reactive({
      threadId: 'thread', agentId: 'child', agentName: 'Child', parentThreadId: 'parent-thread',
      parentAgentId: 'parent', parentAgentName: 'Parent', contractId: 'result', depth: 1, extra: 'not on IPC',
    });
    const tab = readonly(reactive({ ...descriptor('chat'), agentChat, extra: 'ignored' }));
    const copy = structuredClone(payload.descriptor(tab));

    expect(copy.agentChat).toEqual({
      threadId: 'thread', agentId: 'child', agentName: 'Child', parentThreadId: 'parent-thread',
      parentAgentId: 'parent', parentAgentName: 'Parent', contractId: 'result', depth: 1,
    });
    expect(copy).not.toHaveProperty('extra');
    agentChat.threadId = 'changed';
    expect(copy.agentChat?.threadId).toBe('thread');
  });

  it('retains a dirty editor buffer and pin state for adoption without sharing reactive objects', () => {
    const fileEditor = reactive({ filePath: '/scratch/example.txt', text: 'unsaved', dirty: true });
    const transient = structuredClone(payload.transient(reactive({ tabId: 'tab', fileEditor }), true));
    const adoptedDescriptor = structuredClone(payload.descriptor(reactive({ ...descriptor('file-editor'), transferState: fileEditor })));

    fileEditor.text = 'later';
    expect(transient).toEqual({ pinned: true, fileEditor: { filePath: '/scratch/example.txt', text: 'unsaved', dirty: true } });
    expect(adoptedDescriptor.transferState).toEqual(transient.fileEditor);
  });
});
