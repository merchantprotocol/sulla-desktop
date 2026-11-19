// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { ChatController } from '../controller/ChatController';
import { OptimisticSendFeedback } from './OptimisticSendFeedback';

describe('OptimisticSendFeedback', () => {
  it('pushes the user bubble and thinking state before connection status resolves', async() => {
    // risk: availability — slow readiness IPC must not delay visible user feedback.
    const controller = new ChatController();
    const feedback = new OptimisticSendFeedback(controller);
    let resolveStatus!: () => void;
    const connectionStatus = new Promise<void>(resolve => { resolveStatus = resolve; });
    let statusResolved = false;
    void connectionStatus.then(() => { statusResolved = true; });

    const optimistic = feedback.show('hello', [], 1234);
    expect(controller.messages.value).toHaveLength(1);
    expect(controller.messages.value[0]).toMatchObject({ id: optimistic.id, kind: 'user', text: 'hello' });
    expect(controller.runState.value.phase).toBe('thinking');
    expect(statusResolved).toBe(false);

    resolveStatus();
    await connectionStatus;
    controller.dispose();
  });
});
