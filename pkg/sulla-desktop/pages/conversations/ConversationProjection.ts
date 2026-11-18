// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export interface ConversationMessageData {
  messageId: string;
  conversationId: string;
  orgId: string;
  kind: string;
  from: { userId: string; agentId?: string | null };
  to: { userId: string; agentId?: string | null }[];
  body: { text: string; refs?: unknown[] };
  createdAt: string;
  hostSeq?: number;
}

export interface ConversationPerson { userId: string; displayName: string }
export interface ConversationThreadProjection {
  id: string;
  kind: 'direct' | 'group' | 'agent_thread';
  title: string;
  participantIds: string[];
  messages: ConversationMessageData[];
  latest: string;
  unread: number;
}

/** Produces a renderer list from the active member's host-ordered inbox page set. */
export class ConversationProjection {
  project(messages: readonly ConversationMessageData[], people: readonly ConversationPerson[], orgId: string, userId: string): ConversationThreadProjection[] {
    const grouped = new Map<string, ConversationMessageData[]>();
    for (const message of messages) {
      // Inbox data is already participant-scoped by the host; re-check at the UI boundary too.
      if (message.orgId !== orgId || !message.conversationId || (message.from.userId !== userId && !message.to.some(address => address.userId === userId))) continue;
      const rows = grouped.get(message.conversationId) ?? [];
      rows.push(message);
      grouped.set(message.conversationId, rows);
    }
    const personNames = new Map(people.map(person => [person.userId, person.displayName]));
    return [...grouped].map(([id, rows]) => {
      rows.sort((a, b) => (a.hostSeq ?? 0) - (b.hostSeq ?? 0) || a.createdAt.localeCompare(b.createdAt));
      const latest = rows.at(-1);
      const participantIds = [...new Set(rows.flatMap(message => [message.from.userId, ...message.to.map(address => address.userId)]))];
      const hasAgent = rows.some(message => message.kind === 'agent' || message.from.agentId || message.to.some(address => address.agentId));
      const kind = hasAgent ? 'agent_thread' : participantIds.length > 2 ? 'group' : 'direct';
      const remoteId = participantIds.find(id => id !== userId);
      return {
        id,
        kind,
        title: kind === 'group' ? 'Group conversation' : personNames.get(remoteId ?? '') ?? (kind === 'agent_thread' ? 'Agent conversation' : 'Organization member'),
        participantIds,
        messages: rows,
        latest: latest?.body.text ?? '',
        unread: 0,
      };
    }).sort((a, b) => (b.messages.at(-1)?.createdAt ?? '').localeCompare(a.messages.at(-1)?.createdAt ?? ''));
  }
}
