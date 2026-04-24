import type { Attachment } from './Attachment';
import type { QueuedId }   from '../types/chat';

/** A user message that's waiting because a run is in progress. */
export interface QueuedMessage {
  id:          QueuedId;
  text:        string;
  attachments: readonly Attachment[];
  queuedAt:    number;
}
