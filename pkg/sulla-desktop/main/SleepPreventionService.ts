// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ChildProcess } from 'child_process';

export type PowerSaveBlockerAdapter = Pick<import('electron').PowerSaveBlocker, 'start' | 'stop' | 'isStarted'>;

/** Owns each macOS sleep assertion so independent callers cannot release one another. */
export class SleepPreventionService {
  private caffeinateProcess: ChildProcess | null = null;
  private readonly activeHolders = new Set<string>();
  private readonly chatActivityHolders = new Set<string>();
  private readonly relayHolders = new Set<string>();
  private appSuspensionBlockerId: number | null = null;

  constructor(
    private readonly powerSaveBlocker: PowerSaveBlockerAdapter,
    private readonly platform = process.platform,
    private readonly spawnProcess: typeof import('child_process').spawn = require('child_process').spawn,
  ) {}

  startCaffeinate(label: string): void {
    if (this.platform !== 'darwin') return;
    this.activeHolders.add(label);
    if (this.caffeinateProcess) return;
    try {
      const proc = this.spawnProcess('caffeinate', ['-i', '-s'], { stdio: 'ignore', detached: true });
      proc.unref();
      this.caffeinateProcess = proc;
      console.log(`[SleepPrevention] caffeinate started (PID ${ proc.pid }) — holder: ${ label }`);
    } catch (err) {
      console.error('[SleepPrevention] Failed to start caffeinate:', err);
    }
  }

  stopCaffeinate(label: string): void {
    this.activeHolders.delete(label);
    if (this.activeHolders.size > 0 || !this.caffeinateProcess) return;
    try { this.caffeinateProcess.kill(); } catch { /* already dead */ }
    this.caffeinateProcess = null;
  }

  acquireChatActivity(key: string): void {
    if (!key || this.chatActivityHolders.has(key)) return;
    this.chatActivityHolders.add(key);
    if (this.chatActivityHolders.size === 1) this.startCaffeinate('chat-activity');
    this.syncAppSuspensionBlocker(`chat:${ key } acquired`);
  }

  releaseChatActivity(key: string): void {
    if (!this.chatActivityHolders.delete(key)) return;
    if (this.chatActivityHolders.size === 0) this.stopCaffeinate('chat-activity');
    this.syncAppSuspensionBlocker(`chat:${ key } released`);
  }

  /** Keep the Electron main loop live for an authenticated connected relay. */
  acquireRelay(key: string): void {
    if (!key || this.relayHolders.has(key)) return;
    this.relayHolders.add(key);
    this.syncAppSuspensionBlocker(`relay:${ key } acquired`);
  }

  releaseRelay(key: string): void {
    if (!this.relayHolders.delete(key)) return;
    this.syncAppSuspensionBlocker(`relay:${ key } released`);
  }

  releaseAll(): void {
    for (const key of [...this.chatActivityHolders]) this.releaseChatActivity(key);
    for (const key of [...this.relayHolders]) this.releaseRelay(key);
  }

  getActiveHolders(): ReadonlySet<string> { return this.activeHolders; }
  getChatActivityHolders(): ReadonlySet<string> { return this.chatActivityHolders; }
  getRelayHolders(): ReadonlySet<string> { return this.relayHolders; }

  private syncAppSuspensionBlocker(reason: string): void {
    if (this.platform !== 'darwin') return;
    const holderCount = this.chatActivityHolders.size + this.relayHolders.size;
    if (holderCount > 0 && this.appSuspensionBlockerId === null) {
      try {
        this.appSuspensionBlockerId = this.powerSaveBlocker.start('prevent-app-suspension');
        console.log(`[SleepPrevention] prevent-app-suspension started (ID ${ this.appSuspensionBlockerId }) — ${ reason }`);
      } catch (err) {
        console.error('[SleepPrevention] Failed to start prevent-app-suspension:', err);
      }
      return;
    }
    if (holderCount > 0 || this.appSuspensionBlockerId === null) return;
    const blockerId = this.appSuspensionBlockerId;
    this.appSuspensionBlockerId = null;
    try {
      if (this.powerSaveBlocker.isStarted(blockerId)) this.powerSaveBlocker.stop(blockerId);
      console.log(`[SleepPrevention] prevent-app-suspension stopped (ID ${ blockerId }) — ${ reason }`);
    } catch (err) {
      console.error('[SleepPrevention] Failed to stop prevent-app-suspension:', err);
    }
  }
}

class ElectronPowerSaveBlockerAdapter implements PowerSaveBlockerAdapter {
  start(type: 'prevent-app-suspension' | 'prevent-display-sleep'): number {
    return (require('electron') as typeof import('electron')).powerSaveBlocker.start(type);
  }
  stop(id: number): boolean {
    return (require('electron') as typeof import('electron')).powerSaveBlocker.stop(id);
  }
  isStarted(id: number): boolean {
    return (require('electron') as typeof import('electron')).powerSaveBlocker.isStarted(id);
  }
}

const service = new SleepPreventionService(new ElectronPowerSaveBlockerAdapter());

export const startCaffeinate = (label: string): void => service.startCaffeinate(label);
export const stopCaffeinate = (label: string): void => service.stopCaffeinate(label);
export const getActiveHolders = (): ReadonlySet<string> => service.getActiveHolders();
export const acquireChatActivity = (key: string): void => service.acquireChatActivity(key);
export const releaseChatActivity = (key: string): void => service.releaseChatActivity(key);
export const releaseAllChatActivity = (): void => {
  for (const key of [...service.getChatActivityHolders()]) service.releaseChatActivity(key);
};
export const getChatActivityHolders = (): ReadonlySet<string> => service.getChatActivityHolders();
export const acquireRelayLiveness = (key: string): void => service.acquireRelay(key);
export const releaseRelayLiveness = (key: string): void => service.releaseRelay(key);
export const releaseAllSleepPrevention = (): void => service.releaseAll();

export function scheduleWake(_targetDate: Date): void {
  // No-op — pmset requires root, caffeinate handles sleep prevention.
}
