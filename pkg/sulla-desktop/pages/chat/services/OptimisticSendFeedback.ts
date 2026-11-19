// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { asMessageId, newMessageId } from '../types/chat';
import type { ChatController } from '../controller/ChatController';
import type { Attachment } from '../models/Attachment';
import type { UserMessage } from '../models/Message';

/** Owns the optimistic transcript row and thinking transition for a send. */
export class OptimisticSendFeedback {
  constructor(private readonly controller: ChatController) {}

  show(text: string, attachments: Attachment[], at = Date.now()): { id: ReturnType<typeof newMessageId>; text: string } {
    const displayText = text.trim() || '(attached)';
    const id = newMessageId();
    const message: UserMessage = {
      id,
      kind: 'user',
      text: displayText,
      attachments: attachments.map(a => ({ id: a.id, name: a.name, size: a.size, kind: a.kind, fileRef: a.fileRef })),
      createdAt: at,
    };
    this.controller.appendMessage(message);
    this.controller.transitionRun({ type: 'send', messageId: asMessageId(id), at });
    return { id, text: displayText };
  }
}
