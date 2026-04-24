import { describe, it, expect } from '@jest/globals';

import { ChatController } from '../ChatController';
import type { UserMessage, ToolMessage, PatchMessage, ToolApprovalMessage, PatchHunk } from '../../models/Message';
import { newMessageId, newTurnId } from '../../types/chat';

// Helpers
function newController(): ChatController {
  return new ChatController();
}

describe('ChatController — state transitions', () => {
  it('sends a user message and enters thinking phase', () => {
    const c = newController();
    expect(c.runState.value.phase).toBe('idle');
    c.send('hello');
    expect(c.messages.value.length).toBe(1);
    expect(c.messages.value[0].kind).toBe('user');
    expect(c.runState.value.phase).toBe('thinking');
  });

  it('queues instead of sending when running', () => {
    const c = newController();
    c.send('first');
    expect(c.runState.value.phase).toBe('thinking');
    c.send('second');
    expect(c.queue.value.length).toBe(1);
    expect(c.queue.value[0].text).toBe('second');
  });

  it('drains the queue when idle', () => {
    const c = newController();
    c.send('first');
    c.send('second');  // queued
    // Force idle.
    c.stop();
    c.runState.value = { phase: 'idle' };
    // Manually trigger drain.
    c.drainQueueIfIdle();
    expect(c.queue.value.length).toBe(0);
    // Note: the drained message becomes a new user message and transitions runState.
    expect(c.messages.value.filter(m => m.kind === 'user').length).toBe(2);
  });

  it('moves queued messages up/down and removes them', () => {
    const c = newController();
    c.send('running');
    c.send('A');
    c.send('B');
    c.send('C');
    expect(c.queue.value.map(q => q.text)).toEqual(['A', 'B', 'C']);
    c.moveQueuedMessage(c.queue.value[2].id, 'up');
    expect(c.queue.value.map(q => q.text)).toEqual(['A', 'C', 'B']);
    c.removeQueuedMessage(c.queue.value[0].id);
    expect(c.queue.value.map(q => q.text)).toEqual(['C', 'B']);
  });

  it('stop() transitions from thinking to paused', () => {
    const c = newController();
    c.send('hi');
    c.stop();
    expect(c.runState.value.phase).toBe('paused');
    expect((c.runState.value as any).reason).toBe('user');
  });

  it('auto-titles from the first user message', () => {
    const c = newController();
    expect(c.thread.value.title).toBe('New chat');
    c.send('Why is browser/screenshot returning an empty image right after I upsert a tab?');
    expect(c.thread.value.title.length).toBeGreaterThan(0);
    expect(c.thread.value.title).not.toBe('New chat');
  });
});

describe('ChatController — patch + tool approvals', () => {
  it('applies a patch', () => {
    const c = newController();
    const id = newMessageId();
    const hunks: readonly PatchHunk[] = [{ lines: [{ n: 1, text: 'x', op: 'add' }] }];
    const patch: PatchMessage = {
      id, kind: 'patch', createdAt: Date.now(),
      path: 'foo.ts', stat: { added: 1, removed: 0 }, hunks, state: 'proposed',
    };
    c.appendMessage(patch);
    c.applyPatch(id);
    const result = c.messages.value.find(m => m.id === id) as PatchMessage;
    expect(result.state).toBe('applied');
  });

  it('approves/denies tool approval', () => {
    const c = newController();
    const id = newMessageId();
    const appr: ToolApprovalMessage = {
      id, kind: 'tool_approval', createdAt: Date.now(),
      reason: 'run rm', command: 'rm -rf x', decision: 'pending',
    };
    c.appendMessage(appr);
    c.approveTool(id);
    const result = c.messages.value.find(m => m.id === id) as ToolApprovalMessage;
    expect(result.decision).toBe('approved');
  });
});

describe('ChatController — artifacts', () => {
  it('opens, switches, and closes artifacts', () => {
    const c = newController();
    const a1 = c.openArtifact('workflow', { name: 'Routine A' });
    const a2 = c.openArtifact('code',     { name: 'file.ts' });
    expect(c.artifacts.value.list.length).toBe(2);
    expect(c.artifacts.value.activeId).toBe(a2);
    c.switchArtifact(a1);
    expect(c.artifacts.value.activeId).toBe(a1);
    c.closeArtifact(a1);
    expect(c.artifacts.value.list.length).toBe(1);
    expect(c.artifacts.value.activeId).toBe(a2);
    c.closeArtifact(a2);
    expect(c.artifacts.value.list.length).toBe(0);
    expect(c.artifacts.value.activeId).toBe(null);
  });
});

describe('ChatController — serialize + hydrate', () => {
  it('round-trips thread state', () => {
    const a = newController();
    a.send('hello world');
    a.openArtifact('workflow', { name: 'Demo' });
    const snap = a.serialize();

    const b = new ChatController({ hydrateFrom: snap });
    expect(b.thread.value.id).toBe(a.thread.value.id);
    expect(b.messages.value.length).toBe(a.messages.value.length);
    expect(b.artifacts.value.list.length).toBe(1);
  });
});

describe('ChatController — events', () => {
  it('fires messageAppended and runStateChanged', () => {
    const c = newController();
    const events: string[] = [];
    c.on('messageAppended', () => events.push('appended'));
    c.on('runStateChanged', () => events.push('runChanged'));
    c.send('x');
    expect(events).toContain('appended');
    expect(events).toContain('runChanged');
  });
});
