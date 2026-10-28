// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Attachment } from './Attachment';
import type { QueuedId }   from '../types/chat';

/** A user message that's waiting because a run is in progress. */
export interface QueuedMessage {
  id:          QueuedId;
  text:        string;
  attachments: readonly Attachment[];
  queuedAt:    number;
  /** 'voice' when the message was spoken — keeps the reply in voice mode once it drains. */
  inputSource?: 'voice';
}
