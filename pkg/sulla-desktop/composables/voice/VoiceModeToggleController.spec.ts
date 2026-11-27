// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { VoiceModeToggleController } from './VoiceModeToggleController';

class ShortcutEvent {
  defaultPrevented = false;
  propagationStopped = false;

  constructor(
    readonly key: string,
    readonly ctrlKey: boolean,
    readonly metaKey: boolean,
    readonly shiftKey: boolean,
    readonly altKey: boolean,
    readonly repeat: boolean,
  ) {}

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopImmediatePropagation(): void {
    this.propagationStopped = true;
  }

  asKeyboardEvent(): KeyboardEvent {
    return this as unknown as KeyboardEvent;
  }
}

describe('VoiceModeToggleController', () => {
  // risk: duplicate listeners can start/stop the microphone twice for one press.
  it('handles one key press once when multiple composers listen to it', async() => {
    let isRecording = false;
    let startCount = 0;
    let finishStart: (() => void) | undefined;
    const starting = new Promise<void>((resolve) => { finishStart = resolve; });
    const toggleRecording = vi.fn(async() => {
      if (isRecording) {
        isRecording = false;
        return;
      }
      isRecording = true;
      startCount++;
      await starting;
    });
    const dependencies = {
      isRecording: () => isRecording,
      isEnabled:   () => true,
      toggleRecording,
    };
    const firstComposer = new VoiceModeToggleController(dependencies);
    const secondComposer = new VoiceModeToggleController(dependencies);
    const event = new ShortcutEvent('V', true, false, true, false, false);

    const transition = firstComposer.handleShortcut(event.asKeyboardEvent());
    const duplicateTransition = secondComposer.handleShortcut(event.asKeyboardEvent());

    expect(transition).toBeDefined();
    expect(duplicateTransition).toBeUndefined();
    expect(event.defaultPrevented).toBe(true);
    expect(event.propagationStopped).toBe(true);
    await Promise.resolve();
    expect(startCount).toBe(1);

    finishStart?.();
    await transition;
    expect(isRecording).toBe(true);
    expect(toggleRecording).toHaveBeenCalledTimes(1);
  });

  // risk: rapid toggles can leave the requested active state out of sync.
  it('keeps the requested parity after five rapid shortcut presses', async() => {
    let isRecording = false;
    let startCount = 0;
    let stopCount = 0;
    let finishStart: (() => void) | undefined;
    const starting = new Promise<void>((resolve) => { finishStart = resolve; });
    const controller = new VoiceModeToggleController({
      isRecording: () => isRecording,
      isEnabled:   () => true,
      toggleRecording: async() => {
        if (isRecording) {
          isRecording = false;
          stopCount++;
          return;
        }
        isRecording = true;
        startCount++;
        await starting;
      },
    });

    const transitions = Array.from({ length: 5 }, () => controller.handleShortcut(
      new ShortcutEvent('v', false, true, true, false, false).asKeyboardEvent(),
    ));

    await Promise.resolve();
    expect(startCount).toBe(1);
    finishStart?.();
    await Promise.all(transitions.filter((transition): transition is Promise<void> => !!transition));

    expect(isRecording).toBe(true);
    expect(startCount).toBe(1);
    expect(stopCount).toBe(0);
  });

  // risk: stopping during async startup can leave the microphone active after the icon says off.
  it('serializes a click that arrives while voice startup is pending', async() => {
    let isRecording = false;
    let microphoneActive = false;
    let startCount = 0;
    let stopCount = 0;
    let finishStart: (() => void) | undefined;
    const starting = new Promise<void>((resolve) => { finishStart = resolve; });
    const controller = new VoiceModeToggleController({
      isRecording: () => isRecording,
      isEnabled:   () => true,
      toggleRecording: async() => {
        if (isRecording) {
          isRecording = false;
          microphoneActive = false;
          stopCount++;
          return;
        }
        isRecording = true;
        startCount++;
        await starting;
        microphoneActive = true;
      },
    });

    const startingTransition = controller.toggle();
    await Promise.resolve();
    expect(isRecording).toBe(true);
    const stopTransition = controller.toggle();

    finishStart?.();
    await Promise.all([startingTransition, stopTransition]);

    expect(isRecording).toBe(false);
    expect(microphoneActive).toBe(false);
    expect(startCount).toBe(1);
    expect(stopCount).toBe(1);
  });

  // risk: a non-voice composer can accidentally consume a global shortcut.
  it('ignores keyboard shortcuts when voice is disabled', () => {
    const toggleRecording = vi.fn();
    const controller = new VoiceModeToggleController({
      isRecording: () => false,
      isEnabled:   () => false,
      toggleRecording,
    });
    const disabledEvent = new ShortcutEvent('V', true, false, true, false, false);

    expect(controller.handleShortcut(disabledEvent.asKeyboardEvent())).toBeUndefined();
    expect(toggleRecording).not.toHaveBeenCalled();
    expect(disabledEvent.defaultPrevented).toBe(false);
  });

  // risk: holding the shortcut key can repeatedly flip microphone state.
  it('ignores keyboard auto-repeat events', () => {
    const toggleRecording = vi.fn();
    const controller = new VoiceModeToggleController({
      isRecording: () => false,
      isEnabled:   () => true,
      toggleRecording,
    });
    const repeatedEvent = new ShortcutEvent('V', true, false, true, false, true);

    expect(controller.handleShortcut(repeatedEvent.asKeyboardEvent())).toBeUndefined();
    expect(toggleRecording).not.toHaveBeenCalled();
    expect(repeatedEvent.defaultPrevented).toBe(false);
  });
});
