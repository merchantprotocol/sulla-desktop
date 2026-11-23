// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// risk: data integrity. Characterizes the split FilesBrowser through its real controller and the synthetic data
// source /files-preview uses: the collection roots, back/forward history, refusal to navigate or mutate while busy,
// Shift-range selection over the rows actually displayed, inline-rename validation, and mutation error reporting.
// A wiring mistake between the region classes would show up here as the wrong rows, folder or error.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FilesOperationQueue } from '../composables/FilesOperationQueue';
import { useFilesExplorerInteractions } from '../composables/useFilesExplorerInteractions';
import { SyntheticFilesDataSource } from '../SyntheticFilesDataSource';
import { SyntheticFilesFixtures } from '../synthetic/SyntheticFilesFixtures';
import { SyntheticFilesStore } from '../synthetic/SyntheticFilesStore';
import { FilesBrowserController } from './FilesBrowserController';
import { FilesNameRules } from './FilesNameRules';

import type { FilesBrowserEmit, FilesOperations } from './FilesBrowserTypes';
import type { FilesDataSource } from '../types';

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key:string):string | null { return this.values.get(key) ?? null }
  setItem(key:string, value:string):void { this.values.set(key, value) }
  removeItem(key:string):void { this.values.delete(key) }
}

/** The same per-tab binding useFilesOperationQueue returns, without its component unmount hook. */
const operationsFor = (source:FilesDataSource):FilesOperations => {
  const queue = new FilesOperationQueue(source, 'tab', new MemoryStorage());

  return {
    receipts: queue.receipts, current: queue.current, undoable: queue.undoable, pendingRequest: queue.pendingRequest, error: queue.error, active: queue.active,
    supported: () => queue.supported(), submit: request => queue.submit(request), cancel: id => queue.cancel(id), retry: (id, request) => queue.retry(id, request),
    undo: id => queue.undo(id), resume: id => queue.resume(id), restore: id => queue.restore(id), touchesCollection: (receipt, id) => queue.touchesCollection(receipt, id),
  };
};

describe('FilesBrowserController', () => {
  let source:SyntheticFilesDataSource;
  let emit:FilesBrowserEmit;
  let browser:FilesBrowserController;

  beforeEach(async() => {
    vi.stubGlobal('sessionStorage', new MemoryStorage());
    vi.stubGlobal('localStorage', new MemoryStorage());
    vi.stubGlobal('MouseEvent', class {});
    source = new SyntheticFilesDataSource();
    emit = vi.fn() as unknown as FilesBrowserEmit;
    browser = new FilesBrowserController({ dataSource: source, tabId: 'tab' }, emit, useFilesExplorerInteractions('tab'), operationsFor(source));
    browser.state.mounted = true;
    await browser.refresher.refresh();
  });
  afterEach(() => { vi.unstubAllGlobals() });

  const keysOf = () => browser.listing.displayedEntries.value.map(entry => entry.key);

  // risk: a card request disappears after an initial listing failure instead of being retried.
  it('reports an initial listing failure and retries the same file reference after Files reloads', async() => {
    const fileId = 'synthetic-video';
    const lookup = vi.spyOn(source, 'detail');
    vi.spyOn(source, 'load').mockRejectedValueOnce(new Error('private listing bridge failure'));
    browser = new FilesBrowserController({ dataSource: source, tabId: 'tab', navigation: { fileId, section: 'detail' } }, emit, useFilesExplorerInteractions('tab'), operationsFor(source));
    browser.state.mounted = true;

    const firstLoad = browser.refresher.refresh();
    browser.navigation.consumeNavigation();
    expect(emit).not.toHaveBeenCalled();
    expect(browser.state.navigationError.value).toBe('');
    await firstLoad;
    browser.navigation.consumeNavigation();
    expect(browser.state.navigationError.value).toContain('try again');
    expect(browser.state.navigationError.value).not.toContain('private listing');
    expect(lookup).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();

    await browser.refresher.refresh();
    browser.state.busy.value = true;
    browser.navigation.consumeNavigation();
    expect(lookup).not.toHaveBeenCalled();
    browser.state.busy.value = false;
    browser.navigation.consumeNavigation();
    browser.navigation.consumeNavigation();
    await vi.waitFor(() => expect(browser.state.selected.value?.id).toBe(fileId));
    expect(browser.state.navigationError.value).toBe('');
    expect(lookup).toHaveBeenCalledExactlyOnceWith(fileId);
    expect(emit).toHaveBeenCalledExactlyOnceWith('navigation-consumed');
  });

  // risk: data integrity. A nested file reference must select its file row, never navigate into a path as if it were a folder.
  it.each([
    ['ID hit', 'hit'],
    ['ID miss', 'miss'],
    ['ID rejection', 'reject'],
    ['path only', 'path'],
    ['unavailable path', 'unavailable'],
  ] as const)('opens a nested file in the viewer after an %s lookup', async(_label, lookupResult) => {
    const fileId = 'synthetic-video';
    const file = (await source.detail(fileId)).item!;
    const parent = file.path.slice(0, file.path.lastIndexOf('/'));
    expect(file.path).toContain('/');
    browser.state.snapshot.value = { ...browser.state.snapshot.value!, files: browser.state.snapshot.value!.files.filter(item => item.id !== fileId) };

    let lookup:(ids:string[])=>Promise<Array<typeof file>> = async() => [];
    if (lookupResult === 'hit') lookup = async() => [file];
    if (lookupResult === 'reject') lookup = async() => { throw new Error('metadata lookup failed'); };
    const dataSource = source as unknown as FilesDataSource & {
      filesByIds: (ids:string[])=>Promise<Array<typeof file>>;
      loadFolder: (path:string)=>Promise<Array<typeof file>>;
    };
    const filesByIds = vi.fn((ids:string[]) => lookup(ids));
    const loadFolder = vi.fn(async(path:string):Promise<Array<typeof file>> => path === parent && lookupResult !== 'unavailable' ? [file] : []);
    dataSource.filesByIds = filesByIds;
    dataSource.loadFolder = loadFolder;
    if (lookupResult !== 'hit') vi.spyOn(source, 'detail').mockRejectedValue(new Error('metadata detail failed'));

    const request = lookupResult === 'path'
      ? { path: file.path, openKind: 'file' as const }
      : { fileId, path: file.path, openKind: 'file' as const };
    const opened = await browser.navigation.navigateTo(request);

    if (lookupResult === 'unavailable') {
      expect(opened).toBe(false);
      expect(browser.state.selected.value).toBeNull();
      expect(browser.state.navigationError.value).toContain('no longer available');
    } else {
      expect(opened).toBe(true);
      expect(browser.state.currentPath.value).toBe(parent);
      expect(browser.state.currentPath.value).not.toBe(file.path);
      expect(browser.state.selected.value).toMatchObject({ id: fileId, path: file.path });
      expect(browser.state.navigationError.value).toBe('');
    }
    if (lookupResult === 'path') expect(filesByIds).not.toHaveBeenCalled();
    else expect(filesByIds).toHaveBeenCalledExactlyOnceWith([fileId]);
    if (lookupResult === 'hit') expect(loadFolder).not.toHaveBeenCalled();
    else expect(loadFolder).toHaveBeenCalledWith(parent);
  });

  // risk: file routing. Legacy fileId-only references must keep the document-editor route.
  it('preserves the editor route for legacy fileId-only navigation', async() => {
    const file = (await source.detail('synthetic-notes')).item!;

    const opened = await browser.navigation.navigateTo({ fileId: file.id, path: file.path });

    expect(opened).toBe(true);
    expect(emit).toHaveBeenCalledWith('open-editor', expect.objectContaining({ id: file.id, path: file.path }), undefined);
    expect(browser.state.selected.value).toBeNull();
    expect(browser.state.currentPath.value).toBe('');
  });

  // risk: an immutable URL opens the current file instead, or Link publishes on click.
  it('opens the exact older version, defaults a bare reference, and only reviews sharing', async() => {
    const fileId = 'synthetic-video';
    const file = (await source.detail(fileId)).item!;
    const history = (await source.history(fileId, file.currentVersionId)).slice(0, 2);
    const older = history[1];
    vi.spyOn(source, 'history').mockResolvedValue(history);
    const open = vi.spyOn(source, 'openFile');
    const publish = vi.spyOn(source, 'createPublicLink');
    const ref = { fileId, path: 'Untrusted/stale-name.pdf', versionId: older.id };

    await browser.navigation.navigateTo({ ...ref, section: 'detail' });
    expect(browser.state.selected.value).toMatchObject({ id: fileId, path: file.path, currentVersionId: file.currentVersionId });
    expect(browser.state.detailVersion.value?.id).toBe(older.id);
    await browser.navigation.openDetail();
    expect(open).toHaveBeenCalledExactlyOnceWith(fileId, older.id);

    await browser.navigation.navigateTo({ fileId, path: fileId, section: 'detail' });
    expect(browser.state.selected.value?.currentVersionId).toBe(file.currentVersionId);
    expect(browser.state.detailVersion.value).toBeUndefined();

    await browser.navigation.navigateTo({ ...ref, section: 'versions' });
    expect(browser.state.selected.value?.id).toBe(fileId);
    expect(browser.state.detailTab.value).toBe('versions');

    await browser.navigation.navigateTo({ ...ref, section: 'share-review' });
    expect(browser.state.detailVersion.value).toBeUndefined();
    expect(browser.state.selected.value?.currentVersionId).toBe(file.currentVersionId);
    expect(browser.state.shareTarget.value).toMatchObject({ id: fileId, path: file.path, folder: false });
    expect(publish).not.toHaveBeenCalled();
  });

  // risk: stale and denied IDs must not resolve to a same-path file/folder, or open a review.
  it('fails closed on absent, denied, malformed, and stale references', async() => {
    const fileId = 'synthetic-video';
    const file = (await source.detail(fileId)).item!;
    const path = file.path;
    const lookup = vi.spyOn(source, 'detail');
    const folder = vi.spyOn(browser.navigation, 'openPath');
    const publish = vi.spyOn(source, 'createPublicLink');

    // Synthetic metadata returns an unrelated fixture for an unknown ID; navigation must reject it.
    await browser.navigation.navigateTo({ fileId: 'unknown-file', path, section: 'detail' });
    expect(browser.state.navigationError.value).toContain('no longer available');

    lookup.mockRejectedValueOnce(new Error('synthetic 403 private backend detail'));
    await browser.navigation.navigateTo({ fileId, path, section: 'share-review' });
    expect(browser.state.navigationError.value).toContain('Check your connection and access');
    expect(browser.state.navigationError.value).not.toContain('private backend');

    lookup.mockClear();
    await browser.navigation.navigateTo({ fileId: '../bad', path, section: 'detail' });
    expect(lookup).not.toHaveBeenCalled();
    expect(browser.state.navigationError.value).toContain('fresh reference');

    await browser.navigation.navigateTo({ fileId, versionId: 'missing-version', path, section: 'detail' });
    expect(browser.state.navigationError.value).toContain('file version');
    expect(browser.state.selected.value).toBeNull();
    expect(browser.state.shareTarget.value).toBeNull();
    expect(folder).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  // risk: missing capability looks like a dead action or publishes without review.
  it('reports that Link review is unavailable when public links are disabled', async() => {
    const fileId = 'synthetic-video';
    const publish = vi.spyOn(source, 'createPublicLink');
    source.capabilities.publicLinks = false;
    await browser.navigation.navigateTo({ fileId, section: 'share-review' });
    expect(browser.state.navigationError.value).toContain('Link review is unavailable');
    expect(browser.state.shareTarget.value).toBeNull();
    expect(publish).not.toHaveBeenCalled();
  });

  it('opens on one root row per user collection and loads the selected collection', () => {
    expect(browser.state.loading.value).toBe(false);
    expect(browser.state.error.value).toBe('');
    expect(browser.state.snapshot.value?.collection.id).toBe('synthetic-collection');
    expect(browser.location.atRoots.value).toBe(true);
    expect(browser.listing.visibleEntries.value.map(entry => entry.rootCollectionId)).toEqual(['synthetic-collection', 'synthetic-stored-collection']);
  });

  // risk: navigation and data visibility. Distant rows must stay reachable without mounting the whole folder.
  it('reveals the end of an expanded list through the page and releases its virtual height on collapse', async() => {
    source = new SyntheticFilesDataSource(new SyntheticFilesStore(new SyntheticFilesFixtures(0, true), ':page-scroll-test'));
    browser = new FilesBrowserController({ dataSource: source, tabId: 'tab' }, emit, useFilesExplorerInteractions('tab'), operationsFor(source));
    browser.state.mounted = true;
    await browser.refresher.refresh();
    browser.navigation.openPath('Page Scroll');
    browser.navigation.openParent();
    browser.preferences.view.value = 'list';

    // The node test environment supplies viewport geometry; listing and navigation use the real controller.
    const page = { scrollTop: 0, clientHeight: 400, clientTop: 0, getBoundingClientRect: () => ({ top: 10 }) };
    const header = { getBoundingClientRect: () => ({ bottom: 210 - page.scrollTop }) };
    const list = { querySelector: () => header };
    browser.state.mainSurface.value = page as unknown as HTMLElement;
    browser.virtualScroll.listSurface.value = list as unknown as HTMLElement;

    const folder = browser.listing.displayedEntries.value.find(entry => entry.path === 'Page Scroll')!;
    const scroll = browser.virtualScroll;
    scroll.measureListViewport();
    expect(scroll.listBottomSpacer.value).toBe(0);
    browser.listing.toggleFolderExpansion(folder);
    expect(scroll.listBottomSpacer.value).toBeGreaterThan(0);
    expect(scroll.virtualListEntries.value.some(entry => entry.path.startsWith('Page Scroll/Sample 80'))).toBe(false);

    const index = browser.listing.displayedEntries.value.findIndex(entry => entry.path.startsWith('Page Scroll/Sample 80'));
    expect(index).toBeGreaterThan(0);
    scroll.scrollEntryIntoView(index);
    expect(page.scrollTop).toBeGreaterThan(0);
    expect(scroll.listTopSpacer.value).toBeGreaterThan(0);
    expect(scroll.virtualListEntries.value).toContainEqual(browser.listing.displayedEntries.value[index]);

    browser.listing.toggleFolderExpansion(folder);
    expect(scroll.listTopSpacer.value + scroll.listBottomSpacer.value).toBe(0);
    expect(scroll.virtualListEntries.value).toEqual(browser.listing.displayedEntries.value);

    scroll.resetScroll();
    expect(page.scrollTop).toBe(0);
  });

  it('records folder navigation in back/forward history and replays it', () => {
    browser.navigation.openPath('Projects');
    browser.navigation.openPath('Projects/Alpha');
    expect(browser.state.currentPath.value).toBe('Projects/Alpha');
    expect(browser.location.crumbs.value.map(crumb => crumb.path)).toEqual(['Projects', 'Projects/Alpha']);

    browser.navigation.goBack();
    expect(browser.state.currentPath.value).toBe('Projects');
    expect(browser.explorer.canGoForward.value).toBe(true);
    browser.navigation.goForward();
    expect(browser.state.currentPath.value).toBe('Projects/Alpha');
    browser.navigation.openParent();
    expect(browser.state.currentPath.value).toBe('Projects');
    expect(browser.explorer.canGoForward.value).toBe(false);
  });

  it('refuses to navigate or start a mutation while another mutation is running', async() => {
    const operation = vi.fn(async() => undefined);

    browser.navigation.openPath('Projects');
    browser.state.busy.value = true;
    browser.navigation.openPath('Projects/Beta');
    browser.navigation.goBack();
    expect(browser.state.currentPath.value).toBe('Projects');
    expect(await browser.refresher.runMutation(operation)).toBe(false);
    expect(operation).not.toHaveBeenCalled();
  });

  it('reports a failed mutation inline and clears busy', async() => {
    const failed = await browser.refresher.runMutation(async() => { throw new Error('disk is read-only') }, false);

    expect(failed).toBe(false);
    expect(browser.state.operationError.value).toBe('disk is read-only');
    expect(browser.state.busy.value).toBe(false);
  });

  it('selects a Shift range over the displayed rows and adds to it with Cmd', () => {
    browser.navigation.openPath('Projects/Alpha');
    const rows = browser.listing.displayedEntries.value;

    expect(rows.length).toBeGreaterThanOrEqual(4);
    browser.selection.focusEntry(rows[0], { shiftKey: false, metaKey: false, ctrlKey: false } as MouseEvent);
    browser.selection.focusEntry(rows[2], { shiftKey: true, metaKey: false, ctrlKey: false } as MouseEvent);
    expect([...browser.state.selectedKeys.value]).toEqual(keysOf().slice(0, 3));
    expect(browser.selection.selectedEntries.value.map(entry => entry.key)).toEqual(keysOf().slice(0, 3));

    browser.selection.focusEntry(rows[3], { shiftKey: false, metaKey: true, ctrlKey: false } as MouseEvent);
    expect(browser.state.selectedKeys.value.size).toBe(4);
    browser.selection.focusEntry(rows[3], { shiftKey: false, metaKey: false, ctrlKey: false } as MouseEvent);
    expect([...browser.state.selectedKeys.value]).toEqual([rows[3].key]);
  });

  it('keeps an invalid inline rename open with the inline error and submits nothing', async() => {
    browser.navigation.openPath('Projects/Alpha');
    const file = browser.listing.displayedEntries.value.find(entry => !entry.folder)!;
    const submit = vi.spyOn(source, 'submitOperation');

    browser.rename.editingKey.value = file.key;
    browser.rename.renameValue.value = 'elsewhere/name.md';
    await browser.rename.commitRename(file);
    expect(browser.state.operationError.value).toBe(FilesNameRules.RENAME_INVALID);
    expect(browser.rename.editingKey.value).toBe(file.key);
    expect(submit).not.toHaveBeenCalled();
  });

  it('opens a document in the editor and a folder in place when a row is activated', () => {
    browser.navigation.openPath('Projects/Alpha');
    const notes = browser.listing.displayedEntries.value.find(entry => entry.path === 'Projects/Alpha/meeting-notes.md')!;
    const folder = browser.listing.displayedEntries.value.find(entry => entry.folder)!;

    browser.navigation.activate(notes);
    expect(emit).toHaveBeenCalledWith('open-editor', notes, 'synthetic-collection');
    browser.navigation.activate(folder);
    expect(browser.state.currentPath.value).toBe(folder.path);
  });
});
