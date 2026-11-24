// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { CitationMessage } from '../../models/Message';
import type { TranscriptEntry } from './toolGroups';

/**
 * Citation extraction emits a separate message. Associate it with a reply
 * using only Standard entries, so traces cannot affect placement or fallback.
 */
export class ReplyCitationProjection {
  project(entries: readonly TranscriptEntry[]): { byReply: Map<string, CitationMessage[]>; attached: Set<string> } {
    const byReply = new Map<string, CitationMessage[]>();
    const attached = new Set<string>();
    let previousReply: string | undefined;
    let pending: CitationMessage[] = [];
    const attach = (id: string, messages: CitationMessage[]): void => {
      if (!messages.length) return;
      const sources = byReply.get(id) ?? [];
      byReply.set(id, sources.concat(messages));
      for (const message of messages) attached.add(message.id);
    };
    for (const entry of entries) {
      if (entry.kind !== 'card') continue;
      switch (entry.message.kind) {
        case 'sulla':
        case 'streaming':
        case 'html':
          previousReply = entry.id;
          attach(entry.id, pending);
          pending = [];
          break;
        case 'citation':
          if (previousReply) attach(previousReply, [entry.message]);
          else pending.push(entry.message);
          break;
        case 'tts':
        case 'inline_file_reference':
          break;
        default:
          previousReply = undefined;
          pending = [];
      }
    }
    return { byReply, attached };
  }
}
