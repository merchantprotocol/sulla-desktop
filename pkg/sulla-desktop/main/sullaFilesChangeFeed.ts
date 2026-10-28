// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** One serial journal reader per open Files surface; never fetch file bodies. */
export class FilesChangeFeed {
  private timer:ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private seq = '0';
  private failures = 0;
  private initialized = false;

  constructor(
    private readonly read:(after:string, head:boolean) => Promise<{ seq:string; paths:string[]; more:boolean }>,
    private readonly changed:(seq:string, paths:string[]) => void,
  ) {}

  start():void { void this.poll() }
  stop():void { this.stopped = true; if (this.timer) clearTimeout(this.timer) }

  private async poll():Promise<void> {
    let delay = 1000;
    try {
      const page = await this.read(this.seq, !this.initialized);
      if (this.stopped) return;
      const advanced = BigInt(page.seq) > BigInt(this.seq);
      const initial = !this.initialized;
      this.initialized = true;
      this.seq = page.seq;
      this.failures = 0;
      if (initial || (advanced && page.paths.length)) this.changed(this.seq, [...new Set(page.paths)]);
      // Drain bursts without waiting a second for each page.
      if (page.more) delay = 0;
    } catch {
      delay = Math.min(30_000, 1000 * 2 ** Math.min(++this.failures, 5));
    }
    if (!this.stopped) this.timer = setTimeout(() => { void this.poll() }, delay);
  }
}
