// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

const MARKER = /⟦SULLA_A2A:([A-Za-z0-9_-]+)⟧/g;

export interface A2aAgentMessage {
  id?: string;
  recipient: string;
  targetId?: string;
  body: string;
  deliveryStatus: string;
  reason?: string;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function encodeCard(card: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(card));
  const binary = Array.from(bytes, byte => String.fromCharCode(byte)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** Convert persisted extractor markers to safe HTML cards before markdown sanitation. */
export class A2aCardMarkup {
  /** Read persisted outgoing messages without changing the assistant prose. */
  messages(text: string): A2aAgentMessage[] {
    const messages: A2aAgentMessage[] = [];
    for (const match of text.matchAll(MARKER)) {
      const encoded = match[1];
      if (!encoded) continue;
      try {
        const card = this.decodeCard(encoded);
        if (typeof card.body !== 'string') continue;
        messages.push({
          ...(typeof card.id === 'string' ? { id: card.id } : {}),
          recipient: typeof card.to === 'string' && card.to ? card.to : 'agent',
          ...(typeof card.targetId === 'string' && card.targetId ? { targetId: card.targetId } : {}),
          body: card.body,
          deliveryStatus: typeof card.status === 'string' && card.status ? card.status : 'sent',
          ...(typeof card.reason === 'string' && card.reason ? { reason: card.reason } : {}),
        });
      } catch { /* An invalid marker is not a stored agent message. */ }
    }
    return messages;
  }

  /** Remove valid internal markers from prose without leaving a card or gap. */
  strip(text: string): string {
    return text.replace(MARKER, (marker, encoded: string) => {
      try { this.decodeCard(encoded); return ''; }
      catch { return marker; }
    });
  }

  render(text: string): string {
    return text.replace(MARKER, (marker, encoded: string) => {
      try {
        const card = this.decodeCard(encoded);
        const recipient = typeof card.to === 'string' && card.to ? card.to : 'agent';
        const targetId = typeof card.targetId === 'string' && card.targetId ? ` · ${card.targetId}` : '';
        const status = typeof card.status === 'string' && card.status ? card.status : 'sent';
        const reason = typeof card.reason === 'string' && card.reason ? `: ${card.reason}` : '';
        return `<div class="a2a-inline-card"><div class="a2a-inline-head"><b>Agent message</b><span>To ${escapeHtml(`${recipient}${targetId}`)}</span><span class="a2a-inline-status a2a-${escapeHtml(status)}">${escapeHtml(status)}${escapeHtml(reason)}</span></div><div class="a2a-inline-body">${escapeHtml(card.body)}</div></div>`;
      } catch { return escapeHtml(marker); }
    });
  }

  updateStatus(text: string, update: { messageId: string; status: 'sent' | 'delivered' | 'failed'; reason?: string }): string {
    return text.replace(MARKER, (marker, encoded: string) => {
      try {
        const card = this.decodeCard(encoded);
        if (card.id !== update.messageId) return marker;
        if (card.status === 'delivered' && update.status === 'sent') return marker;
        card.status = update.status;
        card.reason = update.reason;
        return `⟦SULLA_A2A:${encodeCard(card)}⟧`;
      } catch { return marker; }
    });
  }

  private decodeCard(encoded: string): Record<string, unknown> {
    const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
    const decoded: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0))));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('Invalid agent message card');
    return decoded as Record<string, unknown>;
  }
}
