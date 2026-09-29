import { describe, expect, it, jest } from '@jest/globals';

import {
  injectSteer, isPendingSteer, markSteerPending, onSteer, pendingSteers, requeuePendingSteers, steerText, takePendingSteers,
} from '../steerChannel';

const user = (content: any, id = 'u') => ({ id, role: 'user', content, timestamp: 0 } as any);
const assistant = (content: string) => ({ id: 'a', role: 'assistant', content, timestamp: 0 } as any);

describe('steerChannel', () => {
  it('leaves a steer pending when no live turn is listening', () => {
    const state = { messages: [user('first')] };
    const steer = user('now', 's1');

    injectSteer(state, steer);

    expect(state.messages).toHaveLength(2);
    expect(isPendingSteer(steer)).toBe(true);
    expect(pendingSteers(state)).toEqual([steer]);
  });

  it('marks a steer delivered when a live listener takes it', () => {
    const state = { messages: [] as any[] };
    const seen: any[] = [];
    onSteer(state, (m) => { seen.push(m); return true });

    const steer = user('now', 's1');
    injectSteer(state, steer);

    expect(seen).toEqual([steer]);
    expect(isPendingSteer(steer)).toBe(false);
    expect(steer.metadata.steerDeliveredAt).toEqual(expect.any(Number));
  });

  it('keeps a steer pending when the listener declines it', () => {
    const state = { messages: [] as any[] };
    onSteer(state, () => false);

    const steer = user('now');
    injectSteer(state, steer);

    expect(isPendingSteer(steer)).toBe(true);
  });

  it('survives a throwing listener', () => {
    const state = { messages: [] as any[] };
    onSteer(state, () => { throw new Error('boom') });

    const steer = user('now');
    expect(() => injectSteer(state, steer)).not.toThrow();
    expect(isPendingSteer(steer)).toBe(true);
  });

  it('offers already-pending steers to a listener that subscribes late', () => {
    const state = { messages: [] as any[] };
    const steer = user('early');
    injectSteer(state, steer);

    const seen: any[] = [];
    onSteer(state, (m) => { seen.push(m); return true });

    expect(seen).toEqual([steer]);
    expect(isPendingSteer(steer)).toBe(false);
  });

  it('stops offering steers after unsubscribe', () => {
    const state = { messages: [] as any[] };
    const listener = jest.fn<() => boolean>(() => true);
    const off = onSteer(state, listener);
    off();

    injectSteer(state, user('late'));

    expect(listener).not.toHaveBeenCalled();
  });

  it('returns a steer to pending when the live turn never used it', () => {
    const state = { messages: [] as any[] };
    onSteer(state, () => true);
    const steer = user('now');
    injectSteer(state, steer);
    expect(isPendingSteer(steer)).toBe(false);

    markSteerPending(steer);

    expect(isPendingSteer(steer)).toBe(true);
  });

  it('requeues unseen steers after the reply that raced them', () => {
    const state = { messages: [user('q1', 'q1')] as any[] };
    const steer = user('steer', 's1');
    injectSteer(state, steer);
    state.messages.push(assistant('answer'));

    expect(requeuePendingSteers(state)).toBe(1);
    expect(state.messages.map(m => m.id)).toEqual(['q1', 'a', 's1']);
    expect(isPendingSteer(state.messages[2])).toBe(true);
  });

  it('requeue is a no-op when nothing is pending', () => {
    const state = { messages: [user('q1', 'q1'), assistant('answer')] as any[] };

    expect(requeuePendingSteers(state)).toBe(0);
    expect(state.messages.map(m => m.id)).toEqual(['q1', 'a']);
  });

  it('takePendingSteers removes them from the transcript', () => {
    const state = { messages: [user('q1', 'q1')] as any[] };
    injectSteer(state, user('s', 's1'));

    const taken = takePendingSteers(state);

    expect(taken.map(m => m.id)).toEqual(['s1']);
    expect(state.messages.map(m => m.id)).toEqual(['q1']);
  });

  it('steerText joins text blocks and ignores images', () => {
    expect(steerText(user('plain'))).toBe('plain');
    expect(steerText(user([
      { type: 'text', text: 'a' },
      { type: 'image', source: {} },
      { type: 'text', text: 'b' },
    ]))).toBe('a\nb');
  });
});
