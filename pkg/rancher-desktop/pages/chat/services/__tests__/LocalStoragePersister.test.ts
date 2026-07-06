import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const invokeMock = jest.fn<(...args: any[]) => Promise<any>>(() => Promise.resolve({ success: true }));

jest.unstable_mockModule('@pkg/utils/ipcRenderer', () => ({
  ipcRenderer: {
    invoke: (...args: any[]) => invokeMock(...args),
    send:   jest.fn(),
    on:     jest.fn(),
  },
}));

const { LocalStoragePersister } = await import('../LocalStoragePersister');
import type { ThreadState } from '../../models/Thread';

function makeState(id: string, messageCount = 1, messageSize = 10): ThreadState {
  return {
    thread: {
      id,
      title:     `thread ${ id }`,
      updatedAt: Date.now(),
      messages:  Array.from({ length: messageCount }, (_, i) => ({
        kind: 'user',
        id:   `m${ i }`,
        text: 'x'.repeat(messageSize),
      })),
    },
  } as unknown as ThreadState;
}

function newPersister(): InstanceType<typeof LocalStoragePersister> {
  (LocalStoragePersister as any)._gcRan = false;

  return new LocalStoragePersister();
}

function quotaError(): DOMException {
  return new DOMException('quota', 'QuotaExceededError');
}

describe('LocalStoragePersister', () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('saves to localStorage, index, and DB backup', () => {
    const p = newPersister();

    p.save(makeState('t1'));

    expect(localStorage.getItem('chat:thread:t1')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('chat:index')!)).toEqual(['t1']);
    expect(invokeMock).toHaveBeenCalledWith('chat-messages:save', 't1', expect.anything());
  });

  it('still dispatches the DB backup when every localStorage write throws quota errors', () => {
    const p = newPersister();

    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw quotaError();
    });

    // Regression: this used to abort before the DB save, losing the message
    // everywhere ("blank thread on first message").
    p.save(makeState('t2'));

    expect(invokeMock).toHaveBeenCalledWith('chat-messages:save', 't2', expect.anything());
  });

  it('caps oversized threads in the cache but sends the full state to the DB', () => {
    const p = newPersister();
    // ~200 messages x 10k chars ≈ 2M units > MAX_THREAD_CACHE_UNITS
    const state = makeState('t3', 200, 10_000);

    p.save(state);

    const cached = JSON.parse(localStorage.getItem('chat:thread:t3')!);

    expect(cached.thread.messages.length).toBe(60);
    const dbPayload: any = invokeMock.mock.calls[0][2];

    expect(dbPayload.thread.messages.length).toBe(200);
  });

  it('startup GC removes orphaned thread blobs not present in the index', () => {
    localStorage.setItem('chat:index', JSON.stringify(['live']));
    localStorage.setItem('chat:thread:live', JSON.stringify(makeState('live')));
    localStorage.setItem('chat:thread:orphan', JSON.stringify(makeState('orphan')));

    newPersister();

    expect(localStorage.getItem('chat:thread:orphan')).toBeNull();
    expect(localStorage.getItem('chat:thread:live')).toBeTruthy();
  });

  it('startup GC evicts oldest threads when the cache exceeds its budget', () => {
    const big = JSON.stringify(makeState('x', 100, 15_000)); // ~1.5M units each

    localStorage.setItem('chat:index', JSON.stringify(['new', 'mid', 'old']));
    localStorage.setItem('chat:thread:new', big);
    localStorage.setItem('chat:thread:mid', big);
    localStorage.setItem('chat:thread:old', big);

    newPersister();

    // ~4.5M total > 3.5M budget — the tail (oldest) goes first.
    expect(localStorage.getItem('chat:thread:old')).toBeNull();
    expect(localStorage.getItem('chat:thread:new')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('chat:index')!)).not.toContain('old');
  });

  it('keeps chat:tab:* pointers during GC so History restore stays linked', () => {
    localStorage.setItem('chat:tab:tab_abc', 'some-thread');
    localStorage.setItem('chat:thread:orphan', '{}');

    newPersister();

    expect(localStorage.getItem('chat:tab:tab_abc')).toBe('some-thread');
  });
});
