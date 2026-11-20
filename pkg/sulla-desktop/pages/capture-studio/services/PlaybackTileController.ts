// SPDX-License-Identifier: GPL-2.0-or-later
export class PlaybackTileController {
  constructor(
    private readonly elementFor: (id: string) => Pick<HTMLMediaElement, 'paused' | 'play' | 'pause'> | null | undefined,
    private readonly remove: (id: string) => void,
    private readonly setPaused: (id: string, paused: boolean) => void,
  ) {}

  isPaused(id: string): boolean { return this.elementFor(id)?.paused ?? true; }

  toggle(id: string): void {
    const element = this.elementFor(id);
    if (!element) return;
    if (element.paused) { void element.play(); this.setPaused(id, false); }
    else { element.pause(); this.setPaused(id, true); }
  }

  pause(id: string): void {
    this.elementFor(id)?.pause();
    this.setPaused(id, true);
  }

  close(id: string): void {
    this.pause(id);
    this.remove(id);
  }
}
