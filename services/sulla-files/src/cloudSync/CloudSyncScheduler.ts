// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Serializes all state changes for one collection (background steps, send, enable, restore). */
export class CollectionLocks {
  private readonly locks = new Map<string, Promise<unknown>>();

  held(collectionId:string):boolean {
    return this.locks.has(collectionId);
  }

  exclusive<T>(collectionId:string, work:() => Promise<T>):Promise<T> {
    const previous = this.locks.get(collectionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    const tail = next.catch(() => undefined);
    this.locks.set(collectionId, tail);
    void tail.then(() => {
      if (this.locks.get(collectionId) === tail) this.locks.delete(collectionId);
    });
    return next;
  }
}

/**
 * One background pass at a time: a nudge during a pass makes it run again right after,
 * otherwise the next pass starts `intervalMs` after the last one ended.
 */
export class CloudSyncScheduler {
  private loop?:Promise<void>;
  private rerun = false;
  private timer?:NodeJS.Timeout;
  private stopped = true;

  constructor(private readonly pass:() => Promise<void>, private readonly intervalMs:number) {}

  get isStopped():boolean {
    return this.stopped;
  }

  start():void {
    this.stopped = false;
    this.schedule(this.intervalMs);
  }

  stop():void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  nudge():void {
    void this.kick();
  }

  /** Starts a pass now (or marks the running one to repeat) and returns it. */
  kick():Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.loop) {
      this.rerun = true;
      return this.loop;
    }
    this.loop = this.pass().finally(() => {
      this.loop = undefined;
      const again = this.rerun;
      this.rerun = false;
      this.schedule(again ? 0 : this.intervalMs);
    });
    return this.loop;
  }

  /** Resolves after `ms` without keeping the process alive. */
  delay(ms:number):Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms).unref());
  }

  private schedule(ms:number):void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.kick();
    }, ms);
    this.timer.unref();
  }
}
