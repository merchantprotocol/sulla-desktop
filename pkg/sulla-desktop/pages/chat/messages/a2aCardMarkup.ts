// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

const MARKER = /⟦SULLA_A2A:([A-Za-z0-9_-]+)⟧/g;

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function decodeCard(encoded: string): any {
  const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0))));
}

function encodeCard(card: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(card));
  const binary = Array.from(bytes, byte => String.fromCharCode(byte)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** Convert persisted extractor markers to safe HTML cards before markdown sanitation. */
export class A2aCardMarkup {
  render(text: string): string {
    return text.replace(MARKER, (marker, encoded: string) => {
      try {
        const card = decodeCard(encoded);
        const target = `${card.to || 'agent'}${card.targetId ? ` · ${card.targetId}` : ''}`;
        return `<div class="a2a-inline-card"><div class="a2a-inline-head"><b>Agent message</b><span>To ${escapeHtml(target)}</span><span class="a2a-inline-status a2a-${escapeHtml(card.status || 'sent')}">${escapeHtml(card.status || 'sent')}${card.reason ? `: ${escapeHtml(card.reason)}` : ''}</span></div><div class="a2a-inline-body">${escapeHtml(card.body)}</div></div>`;
      } catch { return escapeHtml(marker); }
    });
  }

  updateStatus(text: string, update: { messageId: string; status: 'sent' | 'delivered' | 'failed'; reason?: string }): string {
    return text.replace(MARKER, (marker, encoded: string) => {
      try {
        const card = decodeCard(encoded);
        if (card.id !== update.messageId) return marker;
        if (card.status === 'delivered' && update.status === 'sent') return marker;
        card.status = update.status;
        card.reason = update.reason;
        return `⟦SULLA_A2A:${encodeCard(card)}⟧`;
      } catch { return marker; }
    });
  }
}
