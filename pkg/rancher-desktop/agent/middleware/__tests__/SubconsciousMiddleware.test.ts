import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const createSummarizerMock: any = jest.fn();
const createObservationAgentMock: any = jest.fn();
const createIdentityObserverMock: any = jest.fn();
const createIdentityObservationRecallMock: any = jest.fn();
const createToolResultDigesterMock: any = jest.fn();

jest.mock('../../services/GraphRegistry', () => ({
  GraphRegistry: {
    createSummarizer:                createSummarizerMock,
    createObservationAgent:          createObservationAgentMock,
    createIdentityObserver:          createIdentityObserverMock,
    createIdentityObservationRecall: createIdentityObservationRecallMock,
    createToolResultDigester:        createToolResultDigesterMock,
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
});
