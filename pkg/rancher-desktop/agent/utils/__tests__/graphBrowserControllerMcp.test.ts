import { describe, expect, it, jest } from '@jest/globals';

import { registerGraphBrowserControllerMcp } from '../graphBrowserControllerMcp';

import type { BaseThreadState } from '../../nodes/Graph';

function state(metadata: Record<string, unknown>): BaseThreadState {
  return { metadata } as unknown as BaseThreadState;
}

describe('scheduled graph Browser MCP registration', () => {
  it('registers for the explicitly capable Heartbeat state', () => {
    const registerTool = jest.fn();

    const registered = registerGraphBrowserControllerMcp({ registerTool }, state({
      threadId:                     'heartbeat_1',
      graphNativeBrowserController: true,
      userVisibleBrowser:           true,
      allowedToolNames:             ['exec', 'browser_controller'],
    }));

    expect(registered).toBe(true);
    expect(registerTool).toHaveBeenCalledWith(
      'browser_controller',
      expect.any(Object),
      expect.any(Function),
    );
  });

  it.each([
    ['ordinary chat', { threadId: 'chat_1' }],
    ['headless graph', {
      threadId:                     'heartbeat_1',
      graphNativeBrowserController: true,
      userVisibleBrowser:           false,
      allowedToolNames:             ['browser_controller'],
    }],
    ['missing allowlist grant', {
      threadId:                     'heartbeat_1',
      graphNativeBrowserController: true,
      userVisibleBrowser:           true,
      allowedToolNames:             ['exec'],
    }],
  ])('does not register for %s', (_label, metadata) => {
    const registerTool = jest.fn();

    expect(registerGraphBrowserControllerMcp({ registerTool }, state(metadata))).toBe(false);
    expect(registerTool).not.toHaveBeenCalled();
  });
});
