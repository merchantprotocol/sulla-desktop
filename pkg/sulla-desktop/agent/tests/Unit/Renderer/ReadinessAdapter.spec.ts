// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import { ChatController } from '@pkg/pages/chat/controller/ChatController';
import { asMessageId } from '@pkg/pages/chat/types/chat';

vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@pkg/pages/agent/ChatInterface', () => ({ ChatInterface: class {} }));

describe('readiness status in the actual transcript adapter', () => {
  it('removes a cleared status already copied into the controller and retains ordinary replies', async() => {
    const { PersonaAdapter } = await import('@pkg/pages/chat/services/PersonaAdapter');
    const controller = new ChatController();
    const id = asMessageId('readiness-00000000-0000-4000-8000-000000000001');
    controller.appendMessage({ id, kind: 'sulla', createdAt: 0, model: '', text: 'Connecting to Password Vault' });
    controller.appendMessage({ id: asMessageId('reply'), kind: 'sulla', createdAt: 0, model: '', text: 'Keep this reply' });
    const adapter = Object.create(PersonaAdapter.prototype);
    adapter.controller = controller; adapter.ci = { messages: ref([{ id, readinessCleared: true }]) }; adapter.seen = new Set(); adapter.optimisticUserMessages = new Map();
    adapter.lastRawSignature = new Map(); adapter.lastMappedHash = new Map();
    adapter.firstSeenAt = new Map(); adapter.firstCompletedAt = new Map();
    adapter.seenRunning = new Set(); adapter.pendingA2aStatuses = new Map();
    adapter.syncMessages();
    expect(controller.messages.value.map(message => message.id)).toEqual(['reply']);
    adapter.syncMessages();
    expect(controller.messages.value.map(message => message.id)).toEqual(['reply']);
    controller.dispose();
  });
});
