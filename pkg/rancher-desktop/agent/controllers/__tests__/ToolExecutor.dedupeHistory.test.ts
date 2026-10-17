import { describe, expect, it, jest } from '@jest/globals';

const wsSendMock = jest.fn(() => Promise.resolve(true));
const createToolMock = jest.fn();

jest.unstable_mockModule('../../services/WebSocketClientService', () => ({
  getWebSocketClientService: () => ({ send: wsSendMock }),
}));

jest.unstable_mockModule('../../tools/registry', () => ({
  toolRegistry: {
    createTool:           createToolMock,
    findSimilarToolNames: jest.fn(() => []),
  },
}));

jest.unstable_mockModule('@pkg/utils/logging', () => ({
  default: new Proxy({}, {
    get: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() }),
  }),
}));

const { ToolExecutor } = await import('../ToolExecutor');

const makeState = (metadata: Record<string, unknown> = {}) => ({
  messages: [],
  metadata: {
    threadId:  'dedupe-history-test',
    wsChannel: 'dedupe-history-test',
    ...metadata,
  },
}) as any;

const makeExecutor = (parallelToolCalls: boolean) => new ToolExecutor({
  nodeId:                'test-agent',
  nodeName:              'Test Agent',
  currentNodeRunContext: null,
  parallelToolCalls,
  wsChatMessage:         () => Promise.resolve(true),
  bumpStateVersion:      () => undefined,
});

describe('ToolExecutor bounded dedupe history', () => {
  it('drops legacy payload records, caps hashed keys, and preserves both loop detectors', async() => {
    const largePayload = 'x'.repeat(500_000);
    const state = makeState({
      __toolRuns:     [{ toolName: 'browser/screenshot', args: { tabId: -1 }, result: largePayload }],
      __toolRunIndex: { legacy: { result: largePayload } },
    });
    const executor = makeExecutor(false);
    const persist = (executor as any).persistStructuredToolRunRecord.bind(executor);

    for (let i = 0; i < 100; i++) {
      persist(state, {
        toolName:  'browser/screenshot',
        toolRunId: `run-${ i }`,
        args:      { tabId: i, selector: largePayload },
        success:   true,
        result:    { screenshotBase64: largePayload },
      });
    }

    expect(state.metadata.__toolRunIndex).toBeUndefined();
    expect(state.metadata.__toolRuns).toHaveLength(7);
    expect(state.metadata.__toolRuns.every((key: string) => /^sha256:[a-f0-9]{64}$/.test(key))).toBe(true);
    expect(JSON.stringify(state.metadata).length).toBeLessThan(1_000);

    for (const parallelToolCalls of [false, true]) {
      const loopExecutor = makeExecutor(parallelToolCalls);
      const args = { tabId: 42, selector: largePayload };
      const dedupeKey = (loopExecutor as any).buildToolRunDedupeKey('browser/screenshot', args);
      const loopState = makeState({ __toolRuns: Array(7).fill(dedupeKey) });
      const calls = Array.from({ length: parallelToolCalls ? 2 : 1 }, (_, index) => ({
        name: 'browser/screenshot',
        id:   `loop-${ parallelToolCalls }-${ index }`,
        args,
      }));

      const results = await loopExecutor.executeToolCalls(loopState, calls);

      expect(results).toHaveLength(calls.length);
      expect(results.every(result => result.success === false)).toBe(true);
      expect(results.every(result => result.error?.includes('Loop detected'))).toBe(true);
      expect(loopState.metadata.__toolRuns).toHaveLength(7);
    }

    const resumedExecutor = makeExecutor(false);
    const resumedArgs = { tabId: 7 };
    const resumedState = makeState({
      __toolRuns: Array.from({ length: 7 }, (_, index) => ({
        toolName:  'browser/screenshot',
        toolRunId: `legacy-${ index }`,
        dedupeKey: `browser/screenshot:${ JSON.stringify(resumedArgs) }`,
        args:      resumedArgs,
        success:   true,
        result:    { screenshotBase64: largePayload },
      })),
      __toolRunIndex: { legacy: { result: largePayload } },
    });
    const resumedResult = await resumedExecutor.executeToolCalls(resumedState, [{
      name: 'browser/screenshot', id: 'resumed-loop', args: resumedArgs,
    }]);

    expect(resumedResult[0].error).toContain('Loop detected');
    expect(resumedState.metadata.__toolRunIndex).toBeUndefined();
    expect(JSON.stringify(resumedState.metadata).length).toBeLessThan(1_000);

    expect(createToolMock).not.toHaveBeenCalled();
  });
});
