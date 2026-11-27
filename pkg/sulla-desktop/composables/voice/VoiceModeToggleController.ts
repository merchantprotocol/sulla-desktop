// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface VoiceModeToggleDependencies {
  isRecording(): boolean;
  isEnabled(): boolean;
  toggleRecording(): Promise<void> | void;
}

/** Serializes voice-mode requests and consumes a shortcut event only once. */
export class VoiceModeToggleController {
  private requestedState: boolean | undefined;
  private drainPromise: Promise<void> | null = null;

  constructor(private readonly dependencies: VoiceModeToggleDependencies) {}

  toggle(): Promise<void> {
    const currentState = this.requestedState ?? this.dependencies.isRecording();
    this.requestedState = !currentState;
    return this.drainRequests();
  }

  handleShortcut(event: KeyboardEvent): Promise<void> | undefined {
    if (
      !this.dependencies.isEnabled()
      || event.defaultPrevented
      || event.repeat
      || event.altKey
      || !(event.ctrlKey || event.metaKey)
      || !event.shiftKey
      || event.key.toLowerCase() !== 'v'
    ) {
      return undefined;
    }

    // Composers may be mounted in multiple tabs in the same renderer window.
    // Consuming the event here stops later listeners from toggling the shared
    // voice session again for this same physical key press.
    event.preventDefault();
    event.stopImmediatePropagation();
    return this.toggle();
  }

  private drainRequests(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;

    const drain = Promise.resolve()
      .then(() => this.applyRequestedStates())
      .finally(() => {
        this.drainPromise = null;
        if (this.requestedState !== undefined) {
          void this.drainRequests().catch(() => undefined);
        }
      });

    this.drainPromise = drain;
    return drain;
  }

  private async applyRequestedStates(): Promise<void> {
    while (this.requestedState !== undefined) {
      const requestedState = this.requestedState;
      this.requestedState = undefined;

      if (requestedState === this.dependencies.isRecording()) continue;
      await this.dependencies.toggleRecording();
    }
  }
}
