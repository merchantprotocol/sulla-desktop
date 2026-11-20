// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { TabCloseGuardRegistry } from './TabCloseGuardRegistry';

describe('TabCloseGuardRegistry', () => {
  it('keeps the tab when the user cancels a guarded close', async() => {
    // risk: irreversible side effect — cancel must leave capture running and the tab mounted.
    const registry = new TabCloseGuardRegistry();
    const remove = vi.fn();
    registry.register('capture', async() => false);

    await expect(registry.requestClose('capture', remove)).resolves.toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it('runs one teardown and one removal for repeated concurrent close requests', async() => {
    // risk: stream custody — duplicate close intents must not race teardown or release twice.
    const registry = new TabCloseGuardRegistry();
    let confirm!: (allowed: boolean) => void;
    const guard = vi.fn(() => new Promise<boolean>(resolve => { confirm = resolve; }));
    const remove = vi.fn();
    registry.register('capture', guard);

    const first = registry.requestClose('capture', remove);
    const second = registry.requestClose('capture', remove);
    confirm(true);

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('keeps the tab mounted and permits retry when finalization fails', async() => {
    // risk: recording integrity — a failed save must not remove the only route to the session.
    const registry = new TabCloseGuardRegistry();
    const remove = vi.fn();
    const guard = vi.fn().mockRejectedValueOnce(new Error('manifest write failed')).mockResolvedValueOnce(true);
    registry.register('capture', guard);

    await expect(registry.requestClose('capture', remove)).rejects.toThrow('manifest write failed');
    expect(remove).not.toHaveBeenCalled();
    await expect(registry.requestClose('capture', remove)).resolves.toBe(true);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
