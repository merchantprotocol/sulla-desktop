// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// risk: data integrity. Back/forward must return exactly the locations the user left, the cut/copy
// clipboard must hold a frozen copy of each target's expected folder state (it is the CAS guard for
// the later paste), and corrupt or missing stored preferences must never break browsing.
import { describe, expect, it } from 'vitest';

import { FilesExplorerInteractions, type ExplorerPreferenceStorage, type ExplorerTarget } from './FilesExplorerInteractions';

class MemoryStorage implements ExplorerPreferenceStorage {
  readonly values = new Map<string, string>();
  broken = false;
  getItem(key:string) { if (this.broken) throw new Error('denied'); return this.values.get(key) ?? null }
  setItem(key:string, value:string) { if (this.broken) throw new Error('denied'); this.values.set(key, value) }
}

const at = (path:string, section = 'files', collectionId = 'c1') => ({ collectionId, section, path });

describe('FilesExplorerInteractions', () => {
  it('walks back and forward through visited locations and drops forward history on a new visit', () => {
    const explorer = new FilesExplorerInteractions('tab', new MemoryStorage());

    explorer.visit(at(''), at('A'));
    explorer.visit(at('A'), at('A/B'));
    explorer.visit(at('A/B'), at('A/B'));
    expect(explorer.backStack.value).toEqual([at(''), at('A')]);

    expect(explorer.back(at('A/B'))).toEqual(at('A'));
    expect(explorer.back(at('A'))).toEqual(at(''));
    expect(explorer.back(at(''))).toBeNull();
    expect(explorer.canGoBack.value).toBe(false);
    expect(explorer.forward(at(''))).toEqual(at('A'));
    expect(explorer.canGoForward.value).toBe(true);

    explorer.visit(at('A'), at('C'));
    expect(explorer.canGoForward.value).toBe(false);
    expect(explorer.forward(at('C'))).toBeNull();

    explorer.clearForCollection('c2');
    expect(explorer.backStack.value).toEqual([]);
  });

  it('copies clipboard targets so later edits to the selection cannot change the paste guard', () => {
    const explorer = new FilesExplorerInteractions('tab', new MemoryStorage());
    const target:ExplorerTarget = { key: 'k', folderPath: 'A', path: 'A', name: 'A', folder: true, expectedFolder: { folderId: 'f1', path: 'A', revision: '7' } };

    explorer.setClipboard('c1', 'all-authorized', 'cut', [target]);
    target.expectedFolder!.revision = '8';
    target.name = 'renamed';
    expect(explorer.clipboard.value).toEqual({ collectionId: 'c1', sourceCapability: 'all-authorized', mode: 'cut', targets: [{ ...target, name: 'A', expectedFolder: { folderId: 'f1', path: 'A', revision: '7' } }] });
  });

  it('saves preferences per tab, collection and folder and clamps stored column widths', () => {
    const storage = new MemoryStorage();
    const explorer = new FilesExplorerInteractions('tab/1', storage);

    explorer.saveFolderPreferences('c 1', '', { sort: 'size', direction: 'asc', columns: { name: 400, owner: 190, modified: 160, size: 110 }, view: 'grid' });
    expect([...storage.values.keys()]).toEqual(['sulla:files:tab%2F1:c%201:%2F']);
    expect(explorer.loadFolderPreferences('c 1', '')).toEqual({ sort: 'size', direction: 'asc', columns: { name: 400, owner: 190, modified: 160, size: 110 }, view: 'grid' });
    expect(new FilesExplorerInteractions('tab/2', storage).loadFolderPreferences('c 1', '').sort).toBe('modified');

    storage.setItem('sulla:files:tab%2F1:c1:A', JSON.stringify({ sort: 'evil', direction: 'sideways', view: 'tiles', columns: { name: 5, owner: 9999, modified: 'wide' } }));
    expect(explorer.loadFolderPreferences('c1', 'A')).toEqual({ sort: 'modified', direction: 'desc', columns: { name: 72, owner: 720, modified: 160, size: 110 }, view: 'list' });
  });

  it('falls back to defaults when stored preferences are corrupt or storage is unavailable', () => {
    const storage = new MemoryStorage();
    const explorer = new FilesExplorerInteractions('tab', storage);
    const defaults = { sort: 'modified', direction: 'desc', columns: { name: 360, owner: 190, modified: 160, size: 110 }, view: 'list' };

    storage.values.set('sulla:files:tab:c1:A', '{not json');
    expect(explorer.loadFolderPreferences('c1', 'A')).toEqual(defaults);
    storage.broken = true;
    expect(explorer.loadFolderPreferences('c1', 'A')).toEqual(defaults);
    expect(() => explorer.saveFolderPreferences('c1', 'A', defaults as never)).not.toThrow();
  });
});
