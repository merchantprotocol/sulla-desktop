import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const createSummarizerMock: any = jest.fn();
const createEnvironmentBriefMock: any = jest.fn();
const createEpisodicRecallMock: any = jest.fn();
const createSecurityConscienceMock: any = jest.fn();
const createConversationRecallMock: any = jest.fn();
const createObservationAgentMock: any = jest.fn();
const createToolResultDigesterMock: any = jest.fn();

jest.unstable_mockModule('../../services/GraphRegistry', () => ({
  GraphRegistry: {
    createSummarizer:         createSummarizerMock,
    createEnvironmentBrief:   createEnvironmentBriefMock,
    createEpisodicRecall:     createEpisodicRecallMock,
    createSecurityConscience: createSecurityConscienceMock,
    createConversationRecall: createConversationRecallMock,
    createObservationAgent:   createObservationAgentMock,
    createToolResultDigester: createToolResultDigesterMock,
  },
}));

jest.unstable_mockModule('@pkg/utils/logging', () => ({
  default: {
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
    createEnvironmentBriefMock.mockReset();
    createEpisodicRecallMock.mockReset();
    createSecurityConscienceMock.mockReset();
    createConversationRecallMock.mockReset();
    createObservationAgentMock.mockReset();
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
    createEnvironmentBriefMock.mockResolvedValue({
      graph: { execute: jest.fn(() => Promise.resolve()) },
      state: {
        messages:  [],
        metadata: { agent: { response: 'Sulla Desktop tools: project/list_project_items, project/get_project_item.' } },
      },
      threadId: 'environment-brief-test-thread',
    });
    createEpisodicRecallMock.mockResolvedValue({
      graph: { execute: jest.fn(() => Promise.resolve()) },
      state: {
        messages:  [],
        metadata: { agent: { response: '<episodic_context>prior heartbeat workboard proof</episodic_context>' } },
      },
      threadId: 'episodic-recall-test-thread',
    });
    createSecurityConscienceMock.mockResolvedValue({
      graph: { execute: jest.fn(() => Promise.resolve()) },
      state: {
        messages:  [],
        metadata: { agent: { response: 'No risky action detected.' } },
      },
      threadId: 'security-test-thread',
    });
    createConversationRecallMock.mockResolvedValue({
      graph: { execute: jest.fn(() => Promise.resolve()) },
      state: {
        messages:  [],
        metadata: { agent: { response: '<conversation_recall_context>old related turn</conversation_recall_context>' } },
      },
      threadId: 'conversation-recall-test-thread',
    });
    createObservationAgentMock.mockResolvedValue({
      graph: { execute: jest.fn(() => Promise.resolve()) },
      state: {
        messages:  [],
        metadata: { agent: { status: 'done' } },
      },
      threadId: 'observation-agent-test-thread',
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

  it('does not dispatch recall lanes for a normal turn without user text', async() => {
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

    expect(createEnvironmentBriefMock).not.toHaveBeenCalled();
    expect(createEpisodicRecallMock).not.toHaveBeenCalled();
    expect(createSecurityConscienceMock).not.toHaveBeenCalled();
    expect(createConversationRecallMock).not.toHaveBeenCalled();
    expect(createObservationAgentMock).not.toHaveBeenCalled();
    expect(state.metadata).not.toHaveProperty('recallContext');
    expect(state.metadata).not.toHaveProperty('episodicContext');
  });

  it('still dispatches environment and episodic recall for heartbeat cycles without user text', async() => {
    const { runSubconsciousMiddleware } = await import('../SubconsciousMiddleware');
    const state: any = {
      messages:  [{ role: 'assistant', content: 'Previous heartbeat cycle.' }],
      metadata:  { threadId: 'heartbeat_123' },
    };

    await runSubconsciousMiddleware(state, {
      includeObservations: false,
      recallVariant:      'heartbeat',
    });

    expect(createEnvironmentBriefMock).toHaveBeenCalledTimes(1);
    expect(createEnvironmentBriefMock).toHaveBeenCalledWith(state, 'heartbeat');
    expect(createEpisodicRecallMock).toHaveBeenCalledTimes(1);
    expect(createEpisodicRecallMock).toHaveBeenCalledWith(state);
    expect(createSecurityConscienceMock).not.toHaveBeenCalled();
    expect(createConversationRecallMock).not.toHaveBeenCalled();
    expect(state.metadata.recallContext).toBe('Sulla Desktop tools: project/list_project_items, project/get_project_item.');
    expect(state.metadata.episodicContext).toBe('prior heartbeat workboard proof');
  });
});
