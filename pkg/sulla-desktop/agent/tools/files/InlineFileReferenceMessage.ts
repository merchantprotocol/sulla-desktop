// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** The persisted identity needed to resolve a file through its authorized Files API. */
export interface InlineFileReference {
  file_id: string;
  collection_id: string;
}

/**
 * Reference-only assistant message. File bytes, access capabilities, display
 * metadata, and authorization-denial details belong nowhere in this payload.
 */
export interface InlineFileReferenceMessage {
  role: 'assistant';
  kind: 'inline_file_reference';
  thread_id: string;
  tool_call_id: string;
  reference: InlineFileReference;
}

export interface CreateInlineFileReferenceMessage {
  threadId: string;
  toolCallId: string;
  fileId: string;
  collectionId: string;
}

export class InlineFileReferenceMessageFactory {
  create(input: CreateInlineFileReferenceMessage): InlineFileReferenceMessage {
    const values = [input.threadId, input.toolCallId, input.fileId, input.collectionId];
    if (values.some(value => typeof value !== 'string' || !value.trim())) {
      throw new Error('thread, tool-call, file, and collection identities are required');
    }

    return {
      role: 'assistant',
      kind: 'inline_file_reference',
      thread_id: input.threadId,
      tool_call_id: input.toolCallId,
      reference: {
        file_id: input.fileId,
        collection_id: input.collectionId,
      },
    };
  }
}
