import fs from 'node:fs';
import path from 'node:path';

export const FINDER_BADGE_ATTRIBUTE = 'io.sulla.files.sync-state';
/** A badge pass never runs more often than this, however many watcher events arrive. */
export const FINDER_BADGE_MIN_INTERVAL_MS = 60_000;

export interface BadgeFile { path: string; sync_state?: string }
export interface BadgeWrite { target: string; state: string }
export type BadgeSetter = (target: string, state: string) => Promise<void>;

/**
 * Finder sync-state badges, written in-process (no child process per file) and only for
 * files that exist under the Files folder and whose state changed since the last write.
 */
export class FinderBadgeSync {
  private readonly applied = new Map<string, string>();
  private lastRun = 0;
  private running = false;

  constructor(private readonly folder: string, private readonly setter: BadgeSetter, private readonly now: () => number = Date.now) {}

  /** True when a pass may start now; marks it started. */
  begin(): boolean {
    if (this.running || this.now() - this.lastRun < FINDER_BADGE_MIN_INTERVAL_MS) return false;
    this.running = true;
    this.lastRun = this.now();

    return true;
  }

  end(): void { this.running = false }

  async apply(files: BadgeFile[]): Promise<number> {
    let written = 0;

    for (const file of files) {
      const target = path.resolve(this.folder, file.path);
      const state = file.sync_state || 'unknown';

      if (!target.startsWith(`${ this.folder }${ path.sep }`)) continue;
      if (this.applied.get(target) === state) continue;
      if (!await fs.promises.lstat(target).then(() => true, () => false)) continue;
      try {
        await this.setter(target, state);
        this.applied.set(target, state);
        written++;
      } catch { /* Finder metadata is best-effort. */ }
    }

    return written;
  }
}
