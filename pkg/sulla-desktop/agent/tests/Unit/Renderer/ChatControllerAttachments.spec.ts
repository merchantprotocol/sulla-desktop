// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';

import { ChatController } from '@pkg/pages/chat/controller/ChatController';
import type { Attachment } from '@pkg/pages/chat/models';
import { newMessageId } from '@pkg/pages/chat/types/chat';

describe('submitted attachments', () => {
  it('moves submitted files into the queue once and preserves other staged files', () => {
    const controller = new ChatController();
    const file = { id: 'submitted', name: 'qa.txt', kind: 'file', size: '3 B' } as Attachment;
    const later = { ...file, id: 'later' } as Attachment;
    controller.stageAttachment(file); controller.stageAttachment(later);
    controller.transitionRun({ type: 'send', messageId: newMessageId() });
    controller.send('first', [file]);
    expect(controller.queue.value[0].attachments).toEqual([file]);
    expect(controller.staged.value).toEqual([later]);
    controller.send('second');
    expect(controller.queue.value[1].attachments).toEqual([]);
    const send = vi.fn(); controller.setSendHandler(send);
    controller.transitionRun({ type: 'idle' }); controller.drainQueueIfIdle();
    expect(send.mock.calls[0][1]).toEqual([file]);
    controller.dispose();
  });
});
