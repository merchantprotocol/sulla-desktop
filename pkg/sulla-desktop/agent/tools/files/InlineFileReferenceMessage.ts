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
 * Canonical non-shared system record for an opened-file reference. It uses the
 * graph-message shape so transcript storage keeps kind/role `system`. A
 * dispatcher-specific assistant envelope, if needed, belongs at the dispatch
 * boundary and must not replace this stored form.
 */
export interface InlineFileReferenceMessage {
  role: 'system';
  content: '';
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
      role: 'system',
      content: '',
      thread_id: input.threadId,
      tool_call_id: input.toolCallId,
      reference: {
        file_id: input.fileId,
        collection_id: input.collectionId,
      },
    };
  }
}
