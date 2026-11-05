// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { AgentInbox, type AgentInboxEntry, type AgentInboxRepository, type AgentInboxTarget } from '../../../services/AgentInbox';

class MemoryInboxRepository implements AgentInboxRepository {
  readonly rows = new Map<string, { entry: AgentInboxEntry; delivered: boolean }>();
  async enqueue(entry: AgentInboxEntry): Promise<boolean> {
    const id = entry.envelope.ids.messageId;
    if (this.rows.has(id)) return false;
    this.rows.set(id, { entry, delivered: false });
    return true;
  }
  async pending(target: AgentInboxTarget): Promise<AgentInboxEntry[]> {
    return [...this.rows.values()].filter(row => !row.delivered && row.entry.target.channel === target.channel && (!target.threadId || !row.entry.target.threadId || row.entry.target.threadId === target.threadId)).map(row => row.entry);
  }
  async markDelivered(ids: string[]): Promise<void> { for (const id of ids) { const row = this.rows.get(id); if (row) row.delivered = true; } }
}

class RecordingDelivery {
  running = false;
  batches: string[] = [];
  isRunning(): boolean { return this.running; }
  async wake(_target: AgentInboxTarget, batch: string): Promise<void> { this.batches.push(batch); }
}

const entry = (id: string, body = id): AgentInboxEntry => ({
  target: { channel: 'sulla-desktop', threadId: 'receiver-thread' },
  envelope: { from: 'mobile-relay', kind: 'peer', body, ids: { messageId: id, threadId: 'sender-thread' } },
});

describe('AgentInbox', () => {
  it('wakes an idle receiver immediately with peer provenance', async() => {
    // risk: core messaging — idle agents must not strand fleet direction.
    const delivery = new RecordingDelivery();
    const inbox = new AgentInbox(new MemoryInboxRepository(), delivery);
    expect(await inbox.receive(entry('m1', 'pick up I1'))).toBe('delivered');
    expect(delivery.batches).toEqual(['[Peer message from mobile-relay]\npick up I1']);
  });

  it('does not interrupt a running receiver and flushes all messages in one ordered batch', async() => {
    // risk: core messaging — mid-run injection can truncate work or lose sibling messages.
    const delivery = new RecordingDelivery(); delivery.running = true;
    const inbox = new AgentInbox(new MemoryInboxRepository(), delivery);
    await inbox.receive(entry('m1', 'first')); await inbox.receive(entry('m2', 'second'));
    expect(delivery.batches).toEqual([]);
    delivery.running = false;
    expect(await inbox.flush(entry('m1').target)).toBe(2);
    expect(delivery.batches).toHaveLength(1);
    expect(delivery.batches[0]).toContain('first\n\n==========\n\n[Peer message from mobile-relay]\nsecond');
  });

  it.each(['error', 'abort'])('flushes queued messages when a run ends by %s', async() => {
    // risk: core messaging — terminal turns must not strand durable direction.
    const delivery = new RecordingDelivery(); delivery.running = true;
    const inbox = new AgentInbox(new MemoryInboxRepository(), delivery);
    await inbox.receive(entry(`m-${ Math.random() }`, 'recover me'));
    delivery.running = false; // the graph finally block releases the run for either terminal path
    await inbox.flush(entry('target').target);
    expect(delivery.batches).toHaveLength(1);
  });

  it('deduplicates a repeated messageId', async() => {
    // risk: idempotency — retries must never prompt an agent twice.
    const delivery = new RecordingDelivery(); delivery.running = true;
    const inbox = new AgentInbox(new MemoryInboxRepository(), delivery);
    expect(await inbox.receive(entry('same'))).toBe('queued');
    expect(await inbox.receive(entry('same'))).toBe('duplicate');
    delivery.running = false; await inbox.flush(entry('same').target);
    expect(delivery.batches).toHaveLength(1);
  });

  it('survives service restart over the same persistent repository', async() => {
    // risk: durability — process restart must not drop queued fleet direction.
    const repository = new MemoryInboxRepository();
    const before = new RecordingDelivery(); before.running = true;
    await new AgentInbox(repository, before).receive(entry('restart', 'still here'));
    const after = new RecordingDelivery();
    await new AgentInbox(repository, after).flush(entry('restart').target);
    expect(after.batches).toEqual(['[Peer message from mobile-relay]\nstill here']);
  });
});
