import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { toolRegistry } from '../../registry';
import { GraphBrowserControllerWorker } from '../controller';
import { browserToolManifests } from '../manifests';

import type { BaseThreadState } from '../../../nodes/Graph';

function state(metadata: Record<string, unknown>): BaseThreadState {
  return { metadata } as unknown as BaseThreadState;
}

function controller(): GraphBrowserControllerWorker {
  const manifest = browserToolManifests.find(item => item.name === 'browser_controller');
  if (!manifest) throw new Error('browser_controller manifest missing');
  const worker = new GraphBrowserControllerWorker();
  worker.name = manifest.name;
  worker.description = manifest.description;
  worker.schemaDef = manifest.schemaDef;
  return worker;
}

describe('GraphBrowserControllerWorker', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fails closed before loading a browser worker when capability is disabled', async() => {
    const createTool = jest.spyOn(toolRegistry, 'createTool');

    const result = await controller().invoke(
      { tool: 'screenshot', args: {} },
      state({ threadId: 'ordinary-chat', allowedToolNames: ['browser_controller'] }),
    );

    expect(result.success).toBe(false);
    expect(result.result).toContain('disabled');
    expect(createTool).not.toHaveBeenCalled();
  });

  it('delegates with the same graph state and a stable thread-scoped asset id', async() => {
    const innerInvoke = jest.fn<(
      input: unknown,
      state: BaseThreadState,
    ) => Promise<{ toolName: string; success: boolean; result: string }>>().mockResolvedValue({
      toolName: 'tab',
      success:  true,
      result:   'opened',
    });
    jest.spyOn(toolRegistry, 'createTool').mockResolvedValue({ invoke: innerInvoke });
    const graphState = state({
      graphNativeBrowserController: true,
      userVisibleBrowser:           true,
      threadId:                     'heartbeat_123',
      allowedToolNames:             ['exec', 'browser_controller'],
    });

    const result = await controller().invoke({
      tool: 'tab',
      args: { action: 'upsert', url: 'http://127.0.0.1:5173/settings' },
    }, graphState);

    expect(result.success).toBe(true);
    expect(toolRegistry.createTool).toHaveBeenCalledWith('tab');
    expect(innerInvoke).toHaveBeenCalledWith(expect.objectContaining({
      assetId: 'iab_heartbeat_123_127-0-0-1-settings',
    }), graphState);
    expect((graphState.metadata as any).__browserControllerLastAssetId)
      .toBe('iab_heartbeat_123_127-0-0-1-settings');
  });

  it('cannot target a tab outside the bound graph session', async() => {
    const innerInvoke = jest.fn<(
      input: unknown,
      state: BaseThreadState,
    ) => Promise<{ toolName: string; success: boolean; result: string }>>().mockResolvedValue({
      toolName: 'screenshot', success: true, result: 'captured',
    });
    jest.spyOn(toolRegistry, 'createTool').mockResolvedValue({ invoke: innerInvoke });
    const graphState = state({
      graphNativeBrowserController:     true,
      userVisibleBrowser:               true,
      threadId:                         'heartbeat_123',
      allowedToolNames:                 ['browser_controller'],
      __browserControllerLastAssetId:   'iab_heartbeat_123_local',
    });

    const result = await controller().invoke({
      tool: 'screenshot',
      args: { assetId: 'user_private_tab' },
    }, graphState);

    expect(result.success).toBe(true);
    expect(innerInvoke).toHaveBeenCalledWith({ assetId: 'iab_heartbeat_123_local' }, graphState);
  });
});
