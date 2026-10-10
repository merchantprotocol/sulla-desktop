import { describe, expect, it, jest } from '@jest/globals';

import { activateComposerSend, composerSendState } from './ComposerSendBehavior';
import { ChatController } from '../../controller/ChatController';

describe('ComposerSend', () => {
  it('moves from dim to send-ready without invoking stop', () => {
    const controller = new ChatController();
    const stop = jest.fn();
    controller.setRunHandlers({ onStop: stop });
    const send = jest.fn();

    expect(composerSendState(false, false)).toBe('dim');
    activateComposerSend(controller, false, false, send);
    expect(send).not.toHaveBeenCalled();

    expect(composerSendState(false, true)).toBe('ready');
    activateComposerSend(controller, false, true, send);

    expect(send).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
  });

  it('morphs to stop while running and delegates the click to controller.stop', () => {
    const controller = new ChatController();
    const stop = jest.fn();
    controller.setRunHandlers({ onStop: stop });
    controller.send('start a run');
    const send = jest.fn();

    expect(composerSendState(true, false)).toBe('running');
    activateComposerSend(controller, true, false, send);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(controller.runState.value).toMatchObject({ phase: 'paused', reason: 'user' });
    expect(send).not.toHaveBeenCalled();
  });
});
