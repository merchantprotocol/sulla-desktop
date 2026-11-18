// SPDX-License-Identifier: GPL-2.0-or-later
import fs from 'fs';
import path from 'path';

export interface AgentWindowRecord { windowKey: string; bounds: { x: number; y: number; width: number; height: number }; maximized: boolean }

/** Atomic multi-window geometry persistence, retaining entries across app quit. */
export class AgentWindowPersistence {
  private records: AgentWindowRecord[];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private quitting = false;

  constructor(private readonly file: string, private readonly legacyFile: string) {
    try { this.records = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch {
      try {
        const b = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
        this.records = [{ windowKey: 'main', bounds: { x: b.x, y: b.y, width: b.width, height: b.height }, maximized: !!b.maximized }];
      } catch { this.records = []; }
    }
  }
  all(): AgentWindowRecord[] { return this.records.map(record => ({ ...record, bounds: { ...record.bounds } })); }
  setQuitting(): void { this.quitting = true; }
  update(key: string, bounds: AgentWindowRecord['bounds'], maximized: boolean): void {
    const old = this.records.find(record => record.windowKey === key);
    if (old) Object.assign(old, { bounds, maximized }); else this.records.push({ windowKey: key, bounds, maximized });
    this.schedule();
  }
  remove(key: string): void { if (!this.quitting) { this.records = this.records.filter(record => record.windowKey !== key); this.write(); } }
  private schedule(): void { clearTimeout(this.timer); this.timer = setTimeout(() => this.write(), 350); }
  private write(): void {
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); const tmp = `${this.file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(this.records)); fs.renameSync(tmp, this.file); } catch { /* best-effort geometry persistence */ }
  }
}
