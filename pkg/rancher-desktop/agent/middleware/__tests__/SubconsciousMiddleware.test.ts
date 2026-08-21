import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const createSummarizerMock: any = jest.fn();
const createObservationAgentMock: any = jest.fn();
const createIdentityObserverMock: any = jest.fn();
const createIdentityObservationRecallMock: any = jest.fn();
const createToolResultDigesterMock: any = jest.fn();
const createConversationReaderMock: any = jest.fn();

jest.mock('../../services/GraphRegistry', () => ({
  GraphRegistry: {
    createSummarizer:                createSummarizerMock,
    createObservationAgent:          createObservationAgentMock,
    createIdentityObserver:          createIdentityObserverMock,
    createIdentityObservationRecall: createIdentityObservationRecallMock,
    createToolResultDigester:        createToolResultDigesterMock,
    createConversationReader:        createConversationReaderMock,
  },
}));

jest.mock('@pkg/utils/logging', () => ({
  __esModule: true,
  default:    {
    perf: {
      log: jest.fn(),
    },
  },
}));

function stateWithMessages(count: number): any {
  return {
    messages: Array.from({ length: count }, (_, i) => ({
      role:    'assistant',
      content: `message ${ i }`,
    })),
    metadata: {},
  };
}

describe('runSubconsciousMiddleware', () => {
  beforeEach(() => {
    createSummarizerMock.mockReset();
    createObservationAgentMock.mockReset();
    createIdentityObserverMock.mockReset();
    createIdentityObservationRecallMock.mockReset();
    createToolResultDigesterMock.mockReset();
    createConversationReaderMock.mockReset();

    createSummarizerMock.mockResolvedValue({
      graph: {
        execute: jest.fn(() => Promise.resolve()),
      },
      state: {
        messages:  [],
        metadata: {},
      },
      threadId: 'summarizer-test-thread',
    });
    createObservationAgentMock.mockResolvedValue({
      graph: { execute: jest.fn(() => Promise.resolve()) },
      state: {
        messages:  [],
        metadata: { agent: { status: 'done' } },
      },
      threadId: 'observation-agent-test-thread',
    });
    createIdentityObserverMock.mockResolvedValue({
      graph: { execute: jest.fn(() => Promise.resolve()) },
      state: {
        messages:  [],
        metadata: { agent: { status: 'done' } },
      },
      threadId: 'identity-observer-test-thread',
    });
    createIdentityObservationRecallMock.mockResolvedValue({
      graph: { execute: jest.fn(() => Promise.resolve()) },
      state: {
        messages:  [],
        metadata: { agent: { status: 'done', response: '' } },
      },
      threadId: 'identity-recall-test-thread',
    });
    createConversationReaderMock.mockResolvedValue({
      graph: { execute: jest.fn(() => Promise.resolve()) },
      state: {
        messages:  [],
        metadata: { agent: { status: 'done', response: '' } },
      },
      threadId: 'conversation-reader-test-thread',
    });
  });

  it('does not wake the summarizer at the 30-message boundary', async() => {
    const { runSubconsciousMiddleware } = await import('../SubconsciousMiddleware');
    const state = stateWithMessages(30);

    await runSubconsciousMiddleware(state, { includeObservations: false });

    expect(createSummarizerMock).not.toHaveBeenCalled();
  });

  it('wakes the summarizer after 30 messages', async() => {
    const { runSubconsciousMiddleware } = await import('../SubconsciousMiddleware');
    const state = stateWithMessages(31);

    await runSubconsciousMiddleware(state, { includeObservations: false });

    expect(createSummarizerMock).toHaveBeenCalledTimes(1);
    expect(createSummarizerMock).toHaveBeenCalledWith(state);
  });

  it('does not dispatch the observation writer for a turn without user text', async() => {
    const { runSubconsciousMiddleware } = await import('../SubconsciousMiddleware');
    const state: any = {
      messages: [
        { role: 'assistant', content: 'Ready.' },
        {
          role:     'user',
          content:  '',
          metadata: { source: 'subconscious' },
        },
      ],
      metadata: {},
    };

    await runSubconsciousMiddleware(state, { includeObservations: true });

    expect(createObservationAgentMock).not.toHaveBeenCalled();
    expect(createIdentityObserverMock).not.toHaveBeenCalled();
    expect(createIdentityObservationRecallMock).not.toHaveBeenCalled();
  });

  // Conversation Reader (task RpvD) is deliberately NOT wired into the live
  // pre-turn fan-out yet — that registration is task drqq. This locks in the
  // current scope boundary: a normal turn with observations enabled and
  // analyzable user text must never reach GraphRegistry.createConversationReader.
  it('does not dispatch the Conversation Reader from the pre-turn fan-out (deferred to task drqq)', async() => {
    const { runSubconsciousMiddleware } = await import('../SubconsciousMiddleware');
    const state: any = {
      messages: [
        { role: 'user', content: 'What did we decide about the migration last week?' },
      ],
      metadata: {},
    };

    await runSubconsciousMiddleware(state, { includeObservations: true });

    expect(createConversationReaderMock).not.toHaveBeenCalled();
    expect((state.metadata as any).conversationContext).toBeUndefined();
  });
});

describe('runConversationReader', () => {
  beforeEach(() => {
    createConversationReaderMock.mockReset();
  });

  function baseState(): any {
    return {
      messages: [{ role: 'user', content: 'Recall that earlier thread.' }],
      metadata: {},
    };
  }

  it('returns trimmed agent response text when the reader finds relevant content', async() => {
    const execute = jest.fn((..._args: unknown[]) => Promise.resolve());
    createConversationReaderMock.mockResolvedValue({
      graph:    { execute },
      state:    { messages: [], metadata: { agent: { status: 'done', response: '  [thread:abc] prior decision  ' } } },
      threadId: 'conversation-reader-thread',
    });

    const { runConversationReader } = await import('../SubconsciousMiddleware');
    const result = await runConversationReader(baseState());

    expect(result).toBe('[thread:abc] prior decision');
    // No hard iteration cap — graph.execute must be called without a
    // maxIterations option (relies on the prompt's latency guardrails and
    // Graph.execute's own generous default instead).
    expect(execute).toHaveBeenCalledWith(expect.anything(), 'subconscious');
  });

  it('returns null when the reader finds nothing relevant', async() => {
    createConversationReaderMock.mockResolvedValue({
      graph:    { execute: jest.fn(() => Promise.resolve()) },
      state:    { messages: [], metadata: { agent: { status: 'done', response: '' } } },
      threadId: 'conversation-reader-thread',
    });

    const { runConversationReader } = await import('../SubconsciousMiddleware');
    const result = await runConversationReader(baseState());

    expect(result).toBeNull();
  });

  it('returns null (not throw) when the graph fails', async() => {
    createConversationReaderMock.mockRejectedValue(new Error('boom'));

    const { runConversationReader } = await import('../SubconsciousMiddleware');
    const result = await runConversationReader(baseState());

    expect(result).toBeNull();
  });
});
