// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { SleepPreventionService, type PowerSaveBlockerAdapter } from '@pkg/main/SleepPreventionService';

class FakePowerSaveBlocker implements PowerSaveBlockerAdapter {
  starts: Array<'prevent-app-suspension' | 'prevent-display-sleep'> = [];
  stops: number[] = [];
  private nextId = 40;
  private readonly active = new Set<number>();

  start(type: 'prevent-app-suspension' | 'prevent-display-sleep'): number {
    this.starts.push(type);
    const id = ++this.nextId;
    this.active.add(id);
    return id;
  }
  stop(id: number): boolean { this.stops.push(id); return this.active.delete(id); }
  isStarted(id: number): boolean { return this.active.has(id); }
}

const makeService = () => {
  const blocker = new FakePowerSaveBlocker();
  const spawn = (() => ({ unref: () => undefined, kill: () => true })) as unknown as typeof import('child_process').spawn;
  return { blocker, service: new SleepPreventionService(blocker, 'darwin', spawn) };
};

describe('SleepPreventionService relay holder', () => {
  it('holds app suspension across connect, reconnect, and disconnect without leaking', () => {
    // risk: relay disconnects while macOS App-Naps the background app
    const { blocker, service } = makeService();

    service.acquireRelay('desktop-relay');
    service.acquireRelay('desktop-relay');
    expect(blocker.starts).toEqual(['prevent-app-suspension']);

    service.releaseRelay('desktop-relay');
    expect(blocker.stops).toEqual([41]);
    expect(service.getRelayHolders().size).toBe(0);

    service.acquireRelay('desktop-relay');
    service.releaseAll();
    expect(blocker.starts).toHaveLength(2);
    expect(blocker.stops).toEqual([41, 42]);
    expect(service.getRelayHolders().size).toBe(0);
  });

  it('keeps the chat-activity assertion independent from relay reconnects', () => {
    // risk: reconnect releases an unrelated active-chat assertion
    const { blocker, service } = makeService();
    service.acquireChatActivity('run:1');
    service.acquireRelay('desktop-relay');

    service.releaseRelay('desktop-relay');
    expect(blocker.stops).toEqual([]);
    expect(service.getChatActivityHolders()).toEqual(new Set(['run:1']));

    service.releaseChatActivity('run:1');
    expect(blocker.stops).toEqual([41]);
  });
});
