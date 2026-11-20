import { describe, expect, it, vi } from 'vitest';
import { CaptureContextMenuRouter } from './CaptureContextMenuRouter';

describe('CaptureContextMenuRouter', () => {
  const sources = [
    { id: 'screen', type: 'screen' },
    { id: 'screen:secondary', type: 'screen' },
    { id: 'mic', type: 'mic' },
    { id: 'system', type: 'system' },
    { id: 'camera:secondary', type: 'camera' },
  ];

  it('routes screen and camera menus to the exact clicked tile', () => {
    const router = new CaptureContextMenuRouter();
    const handlers = { screen: vi.fn(), camera: vi.fn(), audio: vi.fn() };
    const event = {} as MouseEvent;

    router.open('screen:secondary', sources, event, handlers);
    router.open('camera:secondary', sources, event, handlers);

    expect(handlers.screen).toHaveBeenCalledExactlyOnceWith(event, 'screen:secondary');
    expect(handlers.camera).toHaveBeenCalledExactlyOnceWith(event, 'camera:secondary');
    expect(handlers.audio).not.toHaveBeenCalled();
  });

  it('routes mic and system audio menus to their own source IDs', () => {
    const router = new CaptureContextMenuRouter();
    const handlers = { screen: vi.fn(), camera: vi.fn(), audio: vi.fn() };
    const event = {} as MouseEvent;

    router.open('mic', sources, event, handlers);
    router.open('system', sources, event, handlers);

    expect(handlers.audio).toHaveBeenNthCalledWith(1, event, 'mic');
    expect(handlers.audio).toHaveBeenNthCalledWith(2, event, 'system');
    expect(handlers.audio).toHaveBeenCalledTimes(2);
  });

  it('does not target a default source when an emitted source ID is missing or stale', () => {
    const router = new CaptureContextMenuRouter();
    const handlers = { screen: vi.fn(), camera: vi.fn(), audio: vi.fn() };
    const event = {} as MouseEvent;

    router.open(undefined, sources, event, handlers);
    router.open('removed-source', sources, event, handlers);

    expect(handlers.screen).not.toHaveBeenCalled();
    expect(handlers.camera).not.toHaveBeenCalled();
    expect(handlers.audio).not.toHaveBeenCalled();
  });
});
