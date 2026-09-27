import { describe, expect, it } from '@jest/globals';

import {
  AGENT_GRAPH_WAKE_TYPE,
  isRendererTargetedAgentGraphWake,
  parentGraphWakeMessageType,
  parentGraphWakeRoute,
} from '../AgentGraphWake';

describe('AgentGraph wake routing', () => {
  it('uses a renderer-targeted wake for renderer parents', () => {
    expect(parentGraphWakeRoute('renderer')).toBe('renderer');
    expect(parentGraphWakeMessageType('renderer')).toBe(AGENT_GRAPH_WAKE_TYPE);
  });

  it('keeps main-process parents on the normal graph message path', () => {
    expect(parentGraphWakeRoute('browser')).toBe('main');
    expect(parentGraphWakeMessageType('browser')).toBe('user_message');
  });

  it('recognizes only explicit renderer-targeted wake metadata', () => {
    expect(isRendererTargetedAgentGraphWake({
      type: AGENT_GRAPH_WAKE_TYPE,
      data: { metadata: { dispatchTarget: 'renderer' } },
    })).toBe(true);
    expect(isRendererTargetedAgentGraphWake({
      type: 'user_message',
      data: { metadata: { dispatchTarget: 'renderer' } },
    })).toBe(false);
  });
});
