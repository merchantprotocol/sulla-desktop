// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// risk: file routing. Opening a row must select the editor or the existing in-Sulla preview, never an external app or a no-op.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FilesOperationQueue } from '../composables/FilesOperationQueue';
import { useFilesExplorerInteractions } from '../composables/useFilesExplorerInteractions';
import { FileDetailPreviewRouter } from '../FileDetailPreviewRouter';
import { documentEditorTypeIdForPath } from '../editor/editorTypes';
import { SyntheticFilesDataSource } from '../SyntheticFilesDataSource';
import { FilesBrowserController } from './FilesBrowserController';
import { FilesBrowserOpenDecision } from './FilesBrowserOpenDecision';

import type { FilesBrowserEmit, FilesOperations } from './FilesBrowserTypes';
import type { FilesDataSource } from '../types';

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key:string):string | null { return this.values.get(key) ?? null }
  setItem(key:string, value:string):void { this.values.set(key, value) }
  removeItem(key:string):void { this.values.delete(key) }
}

const operationsFor = (source:FilesDataSource):FilesOperations => {
  const queue = new FilesOperationQueue(source, 'open-decision-test', new MemoryStorage());

  return {
    receipts: queue.receipts, current: queue.current, undoable: queue.undoable, pendingRequest: queue.pendingRequest, error: queue.error, active: queue.active,
    supported: () => queue.supported(), submit: request => queue.submit(request), cancel: id => queue.cancel(id), retry: (id, request) => queue.retry(id, request),
    undo: id => queue.undo(id), resume: id => queue.resume(id), restore: id => queue.restore(id), touchesCollection: (receipt, id) => queue.touchesCollection(receipt, id),
  };
};

describe('FilesBrowserOpenDecision', () => {
  afterEach(() => { vi.unstubAllGlobals() });

  it('routes folders, editor documents, media, supported previews and unknown files to Sulla surfaces', () => {
    const decision = new FilesBrowserOpenDecision(new FileDetailPreviewRouter(), documentEditorTypeIdForPath);
    const cases = [
      { label: 'folder', folder: true, path: 'Projects', mime: 'inode/directory', expected: 'folder' },
      { label: 'video', folder: false, path: 'clip.mp4', mime: 'video/mp4', expected: 'media-preview' },
      { label: 'audio', folder: false, path: 'voice.wav', mime: 'audio/wav', expected: 'media-preview' },
      { label: 'Markdown', folder: false, path: 'notes.md', mime: 'text/markdown', expected: 'editor' },
      { label: 'text', folder: false, path: 'readme.txt', mime: 'text/plain', expected: 'editor' },
      { label: 'image', folder: false, path: 'photo.png', mime: 'image/png', expected: 'detail-preview' },
      { label: 'PDF', folder: false, path: 'report.pdf', mime: 'application/pdf', expected: 'detail-preview' },
      { label: 'binary', folder: false, path: 'archive.bin', mime: 'application/octet-stream', expected: 'detail-preview' },
    ] as const;

    for (const entry of cases) expect(decision.resolve(entry), entry.label).toBe(entry.expected);
  });

  it('uses the shared decision class for row activation and the Open in Sulla menu action', async() => {
    vi.stubGlobal('sessionStorage', new MemoryStorage());
    vi.stubGlobal('localStorage', new MemoryStorage());
    vi.stubGlobal('MouseEvent', class {});

    const source = new SyntheticFilesDataSource();
    const emit = vi.fn() as unknown as FilesBrowserEmit;
    const browser = new FilesBrowserController({ dataSource: source, tabId: 'open-decision-test' }, emit, useFilesExplorerInteractions('open-decision-test'), operationsFor(source));
    browser.state.mounted = true;
    await browser.refresher.refresh();
    browser.navigation.openPath('Projects/Alpha');
    const markdown = browser.listing.displayedEntries.value.find(entry => entry.path === 'Projects/Alpha/meeting-notes.md')!;
    const video = browser.factory.toDisplay((await source.detail('synthetic-video')).item!);
    const decide = vi.spyOn(browser.openDecision, 'resolve');

    browser.navigation.activate(markdown);
    expect(decide).toHaveBeenCalledExactlyOnceWith(markdown);
    expect(emit).toHaveBeenCalledWith('open-editor', markdown, 'synthetic-collection');

    browser.menus.actionTarget.value = video;
    await browser.targetActions.runTargetAction('open-sulla');
    expect(decide).toHaveBeenCalledTimes(2);
    expect(decide).toHaveBeenLastCalledWith(video);
    expect(browser.state.selected.value).toMatchObject({ id: video.id, path: video.path });
  });
});
