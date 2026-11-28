// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { asMessageId, newMessageId, type MessageId } from '../types/chat';
import type { ChatController } from '../controller/ChatController';
import type { Attachment } from '../models/Attachment';
import type { UserMessage } from '../models/Message';

/** Owns the optimistic transcript row and thinking transition for a send. */
export class OptimisticSendFeedback {
  constructor(private readonly controller: ChatController) {}

  show(text: string, attachments: Attachment[], at = Date.now(), messageId?: MessageId): { id: MessageId; text: string } {
    const displayText = text.trim() || '(attached)';
    const id = messageId ?? newMessageId();
    const message: UserMessage = {
      id,
      kind: 'user',
      text: displayText,
      attachments: attachments.map(a => ({ id: a.id, name: a.name, size: a.size, kind: a.kind, fileRef: a.fileRef })),
      createdAt: at,
    };
    // A persisted queue may retry the same send after a renderer restart.
    // Keep the stable correlation id as the transcript id and don't add a
    // second optimistic row when that message was already restored.
    if (!this.controller.messages.value.some(existing => existing.id === id)) this.controller.appendMessage(message);
    this.controller.transitionRun({ type: 'send', messageId: asMessageId(id), at });
    return { id, text: displayText };
  }
}
