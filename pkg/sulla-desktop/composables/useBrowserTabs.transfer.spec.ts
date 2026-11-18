// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';

// useBrowserTabs registers ipcRenderer listeners at module load. Mock the typed
// wrapper so the spec never loads the real 'electron' package (binary path only in Node).
vi.mock('@pkg/utils/ipcRenderer', () => ({
  ipcRenderer: {
    on: vi.fn(),
    once: vi.fn(),
    send: vi.fn(),
    sendSync: vi.fn(),
    invoke: vi.fn(() => Promise.resolve([])),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
  },
}));

import { adoptTransferredTab, applyTransferAdoption, persistActiveTabId, releaseTransferredTab } from './useBrowserTabs';

describe('early tab transfer adoption', () => {
  it('applies an adopted tab before acknowledging transfer readiness', () => {
    // risk: dropped tab during tear-off into a newly-created window
    const tabs: Array<{ id: string }> = [];
    let acknowledged = false;
    applyTransferAdoption(tab => tabs.push(tab), { id: 'tab-new' }, () => { acknowledged = true; });
    expect(tabs).toEqual([{ id: 'tab-new' }]);
    expect(acknowledged).toBe(true);
  });
});

function stubTabElements(rects: Array<{ left: number; width: number }>): void {
  const els = rects.map(r => ({ getBoundingClientRect: () => ({ left: r.left, width: r.width }) }));
  vi.spyOn(document, 'querySelectorAll').mockReturnValue(els as unknown as NodeListOf<HTMLElement>);
}

describe('tab drop position and release ordering', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    persistActiveTabId(null);
  });

  it('inserts a dropped tab at 0 when screenX is left of the first tab midpoint', () => {
    // risk: tab landing in the wrong slot after a tear-off drop
    stubTabElements([{ left: 0, width: 100 }, { left: 100, width: 100 }]);
    const adopted: Array<{ index: number | undefined; id: string }> = [];
    const store = {
      tabs: [{ id: 'a' }, { id: 'b' }] as any[],
      adoptTab: (descriptor: any, index?: number) => { adopted.push({ index, id: descriptor.id }); return descriptor; },
    };
    adoptTransferredTab(store as any, { id: 'tab-new' } as any, undefined, -10 + window.screenX);
    expect(adopted).toEqual([{ index: 0, id: 'tab-new' }]);
  });

  it('inserts between tabs when screenX falls past the first midpoint only', () => {
    // risk: tab landing in the wrong slot after a tear-off drop
    stubTabElements([{ left: 0, width: 100 }, { left: 100, width: 100 }]);
    const adopted: Array<number | undefined> = [];
    const store = {
      tabs: [{ id: 'a' }, { id: 'b' }] as any[],
      adoptTab: (_d: any, index?: number) => { adopted.push(index); return _d; },
    };
    adoptTransferredTab(store as any, { id: 'tab-new' } as any, undefined, window.screenX + 120);
    expect(adopted).toEqual([1]);
  });

  it('appends when no tab elements are rendered yet', () => {
    // risk: adopt before mount must not throw or pick a bogus index
    stubTabElements([]);
    const adopted: Array<number | undefined> = [];
    const store = {
      tabs: [{ id: 'a' }] as any[],
      adoptTab: (_d: any, index?: number) => { adopted.push(index); return _d; },
    };
    adoptTransferredTab(store as any, { id: 'tab-new' } as any, undefined, window.screenX);
    expect(adopted).toEqual([1]);
  });

  it('navigates to a neighbour before releasing the active tab, and acks only after release', async() => {
    // risk: active chat unmounts without saving state, or target adopts before source flushes
    const log: string[] = [];
    const navigated: string[] = [];
    const onNavigate = (ev: Event) => { navigated.push((ev as CustomEvent<{ tabId: string }>).detail.tabId); log.push('navigate'); };
    window.addEventListener('sulla:navigate-tab', onNavigate);
    persistActiveTabId('tab-a');
    const store = {
      tabs: [{ id: 'tab-a' }, { id: 'tab-b' }] as any[],
      releaseTab: (id: string) => { log.push(`release:${ id }`); return { id } as any; },
    };
    await releaseTransferredTab(store as any, 'xfer-1', 'tab-a', (t, id) => log.push(`ack:${ t }:${ id }`));
    window.removeEventListener('sulla:navigate-tab', onNavigate);
    expect(navigated).toEqual(['tab-b']);
    expect(log).toEqual(['navigate', 'release:tab-a', 'ack:xfer-1:tab-a']);
  });

  it('does not navigate when the released tab is not active', async() => {
    // risk: background tab release yanking the user off their current tab
    persistActiveTabId('tab-b');
    const navigate = vi.fn();
    window.addEventListener('sulla:navigate-tab', navigate);
    const ack = vi.fn();
    const store = {
      tabs: [{ id: 'tab-a' }, { id: 'tab-b' }] as any[],
      releaseTab: (id: string) => ({ id } as any),
    };
    await releaseTransferredTab(store as any, 'xfer-2', 'tab-a', ack);
    window.removeEventListener('sulla:navigate-tab', navigate);
    expect(navigate).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith('xfer-2', 'tab-a');
  });
});
