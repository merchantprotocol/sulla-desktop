// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ToolResponse } from '../base';

export interface RecentFileOpenCoordinator {
  openOnce(key:string, open:() => Promise<ToolResponse>):Promise<ToolResponse>;
}

interface RecentOpen {
  expiresAt:number;
  result:Promise<ToolResponse>;
}

/** Shares short-lived open results across FilesOpenWorker instances in Desktop main. */
export class RecentFileOpenRegistry implements RecentFileOpenCoordinator {
  private readonly entries = new Map<string, RecentOpen>();

  constructor(
    private readonly now:() => number = Date.now,
    private readonly windowMs = 1_500,
    private readonly maxEntries = 500,
  ) {}

  async openOnce(key:string, open:() => Promise<ToolResponse>):Promise<ToolResponse> {
    if (!key) return open();

    const now = this.now();
    this.expireEntries(now);
    const existing = this.entries.get(key);
    if (existing) return existing.result;

    this.makeRoom();
    const entry = { expiresAt: now + this.windowMs, result: open() };
    this.entries.set(key, entry);
    try {
      const response = await entry.result;
      if (this.didNotOpen(response) && this.entries.get(key) === entry) this.entries.delete(key);
      return response;
    } catch (error) {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    }
  }

  private expireEntries(now:number):void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  private makeRoom():void {
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.entries.delete(oldest.value);
    }
  }

  private didNotOpen(response:ToolResponse):boolean {
    if (response.successBoolean !== true) return true;
    try {
      return JSON.parse(response.responseString)?.opened === false;
    } catch {
      return false;
    }
  }
}

export const recentFileOpenRegistry = new RecentFileOpenRegistry();
