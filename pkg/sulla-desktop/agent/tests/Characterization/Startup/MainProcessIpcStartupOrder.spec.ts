// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Characterization of onMainProxyLoad after it moved into ordered steps: each
// step finishes (including its awaits) before the next registers, later steps
// see services earlier ones resolved, and a failing step stops the rest just
// as an exception in the old single function did. risk: IPC ready before use.

import { describe, expect, it } from 'vitest';

import {
  MainProcessIpcContext, MainProcessIpcStartup, type MainProcessIpcStep,
} from '../../../../main/startup/MainProcessIpcContext';

class RecordingStep implements MainProcessIpcStep {
  constructor(readonly name: string, private readonly calls: string[], private readonly body?: (ctx: MainProcessIpcContext) => Promise<void>) {}

  async register(ctx: MainProcessIpcContext): Promise<void> {
    this.calls.push(`start:${ this.name }`);
    await this.body?.(ctx);
    this.calls.push(`end:${ this.name }`);
  }
}

function context(): MainProcessIpcContext {
  return new MainProcessIpcContext({ handle: () => undefined }, { getWindow: () => null }, {} as any, {} as any);
}

describe('MainProcessIpcStartup', () => {
  it('runs every step to completion, in order, before starting the next', async() => {
    const calls: string[] = [];
    const slow = async() => { await new Promise(resolve => setTimeout(resolve, 5)) };
    const startup = new MainProcessIpcStartup([
      new RecordingStep('bootstrap', calls, slow), new RecordingStep('tab-views', calls), new RecordingStep('vault', calls, slow),
    ]);

    await startup.load(context());

    expect(calls).toEqual(['start:bootstrap', 'end:bootstrap', 'start:tab-views', 'end:tab-views', 'start:vault', 'end:vault']);
  });

  it('lets later steps use services an earlier step resolved', async() => {
    const calls: string[] = [];
    const tabs = { setFocusedTab: () => undefined } as any;
    let seen: unknown;
    const startup = new MainProcessIpcStartup([
      new RecordingStep('tab-views', calls, async(ctx) => { ctx.tabViewManager = tabs }),
      new RecordingStep('vault', calls, async(ctx) => { seen = ctx.tabs() }),
    ]);

    await startup.load(context());

    expect(seen).toBe(tabs);
  });

  it('refuses a dependent lookup when the providing step has not run', () => {
    const ctx = context();

    expect(() => ctx.tabs()).toThrow('Browser tab views are not registered yet');
    expect(() => ctx.vaultKeys()).toThrow('Vault key IPC is not registered yet');
    expect(() => ctx.vaultStatusMonitor()).toThrow('Vault status IPC is not registered yet');
  });

  it('stops at a failing step and does not register the steps after it', async() => {
    const calls: string[] = [];
    const startup = new MainProcessIpcStartup([
      new RecordingStep('bootstrap', calls),
      new RecordingStep('accounts', calls, async() => { throw new Error('import failed') }),
      new RecordingStep('vault', calls),
    ]);

    await expect(startup.load(context())).rejects.toThrow('import failed');
    expect(calls).toEqual(['start:bootstrap', 'end:bootstrap', 'start:accounts']);
  });
});
