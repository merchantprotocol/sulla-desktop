// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Attachment } from './Attachment';
import type { UseCaseIntentMetadata } from '@pkg/shared/useCaseSuggestions';
import type { QueuedId }   from '../types/chat';
import type { HumanSendRoute } from '@pkg/shared/HumanSend';

/** A user message that's waiting because a run is in progress. */
export interface QueuedMessage {
  id:          QueuedId;
  text:        string;
  attachments: readonly Attachment[];
  queuedAt:    number;
  /** Correlates renderer delivery with the backend's acceptance receipt. */
  sendId:      string;
  /** IDs of additional voice fragments combined into this queued utterance. */
  coalescedSendIds?: string[];
  route:       HumanSendRoute;
  deliveryStatus: 'pending' | 'delivering';
  enqueuedAtMs: number;
  /** A Stop cancelled this unaccepted send; only an explicit retry may dispatch it. */
  cancelledByStop?: boolean;
  /** 'voice' when the message was spoken — keeps the reply in voice mode once it drains. */
  inputSource?: 'voice';
  voiceTurnId?: string;
  voiceIdentity?: { voiceId: string; voiceLabel: string; isOwner: boolean; score: number };
  /** Use-case chip picked for this message; travels with it through the queue. */
  useCaseIntent?: UseCaseIntentMetadata;
  /** Agent an "Ask <agent>" chip routes this message to. */
  agentId?: string;
}
