// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Message } from '../models/Message';
import { asMessageId } from '../types/chat';

import type { RemoteThreadBinding } from '../models/Thread';

type Row = { id: string; content?: string; role: string; status?: string; created_at: string; updated_at?: string };
type Page = { messages: Row[]; removedMessageIds?: string[]; nextCursor: string; hasMore: boolean };
type Reply = { status: number; page?: Page };
type Request = (thread: string, cursor: string, ids: string[], reconcileOnly: boolean) => Promise<Reply>;

export class RemoteChatHistory {
  constructor(private readonly fetchPage: Request) {}

  async catchUp(binding: RemoteThreadBinding, cached: readonly Message[], alive: () => boolean): Promise<{ cursor: string; messages: Message[]; removed: string[]; confirmed: string[] } | undefined> {
    let cursor = binding.cursor ?? 'start';
    const rows = new Map(cached.filter(message => message.kind !== 'streaming').map(message => [String(message.id), message]));
    const revisions = new Map<string, number>();
    const removed = new Set<string>();
    const unconfirmed = new Set(binding.unconfirmedMessageIds ?? []);
    const cachedIds = [...rows.keys()].filter(id => !unconfirmed.has(id) && /^[A-Za-z0-9_.:-]{1,200}$/.test(id));
    const apply = (page: Page) => {
      for (const id of page.removedMessageIds ?? []) { rows.delete(id); removed.add(id) }
      for (const row of page.messages) {
        if (typeof row.id !== 'string' || typeof row.content !== 'string') continue;
        const createdAt = Date.parse(row.created_at);
        if (!Number.isFinite(createdAt)) continue;
        const revision = Date.parse(row.updated_at ?? row.created_at);
        if ((revisions.get(row.id) ?? 0) > revision) continue;
        const base = { id: asMessageId(row.id), text: row.content, createdAt };
        if (row.role === 'user') rows.set(row.id, { ...base, kind: 'user' });
        else if (row.role === 'assistant') rows.set(row.id, { ...base, kind: 'sulla', model: '' });
        else if (row.role === 'tool' && /^relay_outcome_[a-f0-9]{64}$/.test(row.id)) {
          // The shared endpoint allowlists this one non-actionable card.
          let outcome: unknown;
          try {
            const card = JSON.parse(row.content)?.sullaCard;
            if (card?.version !== 1 || card.kind !== 'run_outcome' || typeof card.runId !== 'string') continue;
            outcome = card.outcome;
          } catch { continue }
          if (outcome !== 'completed' && outcome !== 'failed' && outcome !== 'stopped') continue;
          rows.set(row.id, { id: base.id, createdAt, kind: 'notice', text: `Run ${ outcome }` });
        } else continue; // Never render unapproved tool/card payloads as actions.
        removed.delete(row.id);
        revisions.set(row.id, revision);
      }
    };
    for (let index = 0; index < 4096; index++) {
      const result = await this.fetchPage(binding.threadId, cursor, [], false);
      if (!alive()) return;
      if (result.status === 400 && index === 0 && cursor !== 'start') {
        cursor = 'start';
        continue;
      }
      if (result.status !== 200 || !result.page || !Array.isArray(result.page.messages) || !result.page.nextCursor) return;
      apply(result.page);
      if (result.page.hasMore && cursor === result.page.nextCursor) return;
      cursor = result.page.nextCursor;
      if (result.page.hasMore) continue;
      for (let offset = 0; offset < cachedIds.length; offset += 96) {
        const batch = await this.fetchPage(binding.threadId, cursor, cachedIds.slice(offset, offset + 96), true);
        if (!alive() || batch.status !== 200 || !batch.page || !Array.isArray(batch.page.messages)) return;
        apply(batch.page);
      }
      return { cursor, removed: [...removed], confirmed: [...revisions.keys()].filter(id => !removed.has(id)), messages: [...rows.values()].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
    }
  }
}
