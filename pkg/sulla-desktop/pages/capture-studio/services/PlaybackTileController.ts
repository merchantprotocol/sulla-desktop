// SPDX-License-Identifier: GPL-2.0-or-later
export class PlaybackTileController {
  constructor(
    private readonly elementFor: (id: string) => Pick<HTMLMediaElement, 'paused' | 'play' | 'pause'> | null | undefined,
    private readonly remove: (id: string) => void,
    private readonly pausedFor: (id: string) => boolean,
    private readonly setPaused: (id: string, paused: boolean) => void,
  ) {}

  isPaused(id: string): boolean { return this.pausedFor(id); }

  toggle(id: string): void {
    const element = this.elementFor(id);
    if (!element) return;
    if (this.isPaused(id)) {
      this.setPaused(id, false);
      try { void Promise.resolve(element.play()).catch(() => this.setPaused(id, true)); }
      catch { this.setPaused(id, true); }
    }
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
