// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { PublishApprovalCoordinator } from '../../../tools/files/PublishApprovalCoordinator';

describe('PublishApprovalCoordinator', () => {
  it('delivers one terminal publish outcome and ignores unrelated decisions', async () => {
    let listener: ((record: any) => void) | undefined;
    const source = { subscribe: (next: (record: any) => void) => { listener = next; return () => { listener = undefined } } };
    const subject = new PublishApprovalCoordinator(source);
    const messages: string[] = [];
    subject.start();
    subject.register('d1', async message => { messages.push(message); return true });
    listener?.({ id: 'd1', kind: 'approval', status: 'deferred', payload: { filesPublishRequestId: 'f1' } });
    listener?.({ id: 'd1', kind: 'approval', status: 'approved', payload: { filesPublishRequestId: 'f1' } });
    listener?.({ id: 'd1', kind: 'approval', status: 'approved', payload: { filesPublishRequestId: 'f1' } });
    listener?.({ id: 'q1', kind: 'question', status: 'approved', payload: { filesPublishRequestId: 'f1' } });
    await Promise.resolve();
    expect(messages).toEqual(['File version publish approved.']);
  });

  it('dispose unsubscribes and clears callbacks', async () => {
    let listener: ((record: any) => void) | undefined;
    const source = { subscribe: (next: (record: any) => void) => { listener = next; return () => { listener = undefined } } };
    const subject = new PublishApprovalCoordinator(source);
    const messages: string[] = [];
    subject.start();
    subject.register('d1', async message => { messages.push(message); return true });
    subject.dispose();
    listener?.({ id: 'd1', kind: 'approval', status: 'approved', payload: { filesPublishRequestId: 'f1' } });
    await Promise.resolve();
    expect(messages).toEqual([]);
  });

  it('bounds delivered decisions while suppressing recent redelivery', async () => {
    let listener: ((record: any) => void) | undefined;
    const source = { subscribe: (next: (record: any) => void) => { listener = next; return () => { listener = undefined } } };
    const subject = new PublishApprovalCoordinator(source);
    let sends = 0;
    subject.start();

    for (let index = 0; index < 501; index += 1) {
      const id = `d${ index }`;
      subject.register(id, async () => { sends += 1; return true });
      listener?.({ id, kind: 'approval', status: 'approved', payload: { filesPublishRequestId: `f${ index }` } });
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(sends).toBe(501);
    expect((subject as any).delivered.size).toBe(500);
    listener?.({ id: 'd500', kind: 'approval', status: 'approved', payload: { filesPublishRequestId: 'f500' } });
    await Promise.resolve();
    expect(sends).toBe(501);
  });
});
