// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// Opening a saved document (e.g. a Supporting report) in the Paper tab: the real DocumentPage runs;
// the folder-scoped Files listing and the exact-id metadata IPC are the faked boundaries.
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  metadata: new Map<string, () => Promise<unknown>>(),
}));
vi.mock('electron', () => ({ ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn(), send: vi.fn() } }));
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: {
  invoke: vi.fn((channel: string, input?: { fileId?: string }) => {
    if (channel === 'sulla-files:metadata') return (f.metadata.get(input?.fileId ?? '') ?? (() => Promise.reject(new Error('404 not found'))))();
    return Promise.resolve(undefined);
  }),
  on: vi.fn(), removeListener: vi.fn(), send: vi.fn(), sendSync: vi.fn(),
} }));

import DocumentPage from '@pkg/pages/DocumentPage.vue';
import { DesktopFilesDataSource } from '@pkg/pages/files/DesktopFilesDataSource';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const COLLECTION = 'collection-home';
const record = (id: string, path: string, extra: Record<string, unknown> = {}) => ({
  id, path, collection_id: COLLECTION, current_version_id: `${ id }-v1`, mime: 'text/markdown', size: 12,
  updated_at: '2026-11-17T12:00:00Z', created_by_type: 'agent', created_by_id: 'codex-luna-worker', version_count: 1, ...extra,
});
const rootFile = { id: 'root-note', path: 'notes.md', mime: 'text/markdown', size: 4, updatedAt: '2026-11-17T12:00:00Z', currentVersionId: 'v1', versionCount: 1, createdByType: 'user', createdById: 'me', indexStatus: 'indexed', indexReason: '' };

function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise(accept => { resolve = accept });
  return { promise, resolve };
}

/** The data source lists only the selected folder (root here), as DesktopFilesDataSource.load does. */
function rootListing(collectionId = COLLECTION) {
  return vi.spyOn(DesktopFilesDataSource.prototype, 'load').mockResolvedValue({ collection: { id: collectionId, name: 'Home' }, files: [rootFile] } as any);
}

const mounted: VueWrapper[] = [];
function open(fileId: string, path: string, collectionId: string | undefined = COLLECTION) {
  const wrapper = shallowMount(DocumentPage, { props: { tabId: 'paper-tab', documentFile: { fileId, path, ...(collectionId ? { collectionId } : {}) } } });
  mounted.push(wrapper);
  return wrapper;
}
const shown = (wrapper: VueWrapper) => wrapper.findComponent({ name: 'DocumentEditorShell' }).exists()
  ? (wrapper.findComponent({ name: 'DocumentEditorShell' }).props('item') as { id: string; path: string })
  : null;

beforeEach(() => { f.metadata.clear(); vi.mocked(ipcRenderer.invoke).mockClear() });
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()); vi.restoreAllMocks() });

describe('opening a saved document in the Paper tab', () => {
  it('opens a nested report that the root folder listing does not contain, by its exact id', async() => {
    rootListing();
    f.metadata.set('audit-report', () => Promise.resolve(record('audit-report', 'Reports/Frontend/frontend-safety-audit.md')));
    const wrapper = open('audit-report', 'Reports/Frontend/frontend-safety-audit.md');
    await flushPromises();
    expect(shown(wrapper)).toMatchObject({ id: 'audit-report', path: 'Reports/Frontend/frontend-safety-audit.md' });
    expect(wrapper.text()).not.toContain('This file is no longer available');
  });

  it('still opens a document present in the listing without a separate lookup', async() => {
    rootListing();
    const wrapper = open('root-note', 'notes.md');
    await flushPromises();
    expect(shown(wrapper)).toMatchObject({ id: 'root-note' });
    expect(vi.mocked(ipcRenderer.invoke).mock.calls.some(([channel]) => channel === 'sulla-files:metadata')).toBe(false);
  });

  it.each([
    ['a missing file', () => undefined],
    ['a deleted file', () => f.metadata.set('audit-report', () => Promise.resolve(record('audit-report', 'Reports/a.md', { deleted_at: '2026-11-17T12:30:00Z' })))],
    ['a file in another collection', () => f.metadata.set('audit-report', () => Promise.resolve(record('audit-report', 'Reports/a.md', { collection_id: 'someone-elses' })))],
  ])('shows the unavailable state for %s', async(_label, arrange) => {
    rootListing();
    arrange();
    const wrapper = open('audit-report', 'Reports/a.md');
    await flushPromises();
    expect(shown(wrapper)).toBeNull();
    expect(wrapper.text()).toContain('This file is no longer available');
  });

  it('fails closed when the saved collection is not the one that loaded', async() => {
    rootListing('default-collection');
    f.metadata.set('audit-report', () => Promise.resolve(record('audit-report', 'Reports/a.md', { collection_id: 'default-collection' })));
    const wrapper = open('audit-report', 'Reports/a.md', COLLECTION);
    await flushPromises();
    expect(shown(wrapper)).toBeNull();
  });

  it('does not guess another file at the same path', async() => {
    vi.spyOn(DesktopFilesDataSource.prototype, 'load').mockResolvedValue({ collection: { id: COLLECTION, name: 'Home' }, files: [{ ...rootFile, id: 'different-file', path: 'Reports/a.md' }] } as any);
    const wrapper = open('audit-report', 'Reports/a.md');
    await flushPromises();
    expect(shown(wrapper)).toBeNull();
  });

  it('never paints the previous document when its slower load finishes after a switch', async() => {
    rootListing();
    const slow = deferred();
    f.metadata.set('first-report', () => slow.promise);
    f.metadata.set('second-report', () => Promise.resolve(record('second-report', 'Reports/second.md')));
    const wrapper = open('first-report', 'Reports/first.md');
    await flushPromises();
    await wrapper.setProps({ documentFile: { fileId: 'second-report', path: 'Reports/second.md', collectionId: COLLECTION } });
    await flushPromises();
    expect(shown(wrapper)).toMatchObject({ id: 'second-report' });
    slow.resolve(record('first-report', 'Reports/first.md'));
    await flushPromises();
    expect(shown(wrapper)).toMatchObject({ id: 'second-report' });
  });
});

// A restored Paper tab can mount before Files has finished unlocking. Its first reads then fail with
// a bounded, transient readiness error; the page waits and opens the same exact document once ready.
describe('opening a restored document while Files is still starting', () => {
  const NESTED = 'Reports/Frontend/frontend-safety-audit.md';
  const shuttingDown = () => new Error("Error invoking remote method 'sulla-files:collections': Error: Files is shutting down");
  const snapshot = (collectionId = COLLECTION) => ({ collection: { id: collectionId, name: 'Home' }, files: [rootFile] } as any);
  const retryButton = (wrapper: VueWrapper) => wrapper.findAll('button').find(button => button.text() === 'Retry');
  const status = (wrapper: VueWrapper) => wrapper.find('[role="status"]');

  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) });
  afterEach(() => { vi.useRealTimers() });

  it('shows a connecting state while Files is not ready, then opens the same exact nested report', async() => {
    const load = vi.spyOn(DesktopFilesDataSource.prototype, 'load')
      .mockRejectedValueOnce(shuttingDown()).mockRejectedValueOnce(shuttingDown()).mockResolvedValue(snapshot());
    f.metadata.set('audit-report', () => Promise.resolve(record('audit-report', NESTED)));
    const wrapper = open('audit-report', NESTED);
    await flushPromises();
    expect(status(wrapper).exists()).toBe(true);
    expect(status(wrapper).text()).toMatch(/Connecting to Files/);
    expect(wrapper.text()).not.toContain('shutting down');
    expect(shown(wrapper)).toBeNull();

    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(load).toHaveBeenCalledTimes(3);
    expect(shown(wrapper)).toMatchObject({ id: 'audit-report', path: NESTED });
    expect(status(wrapper).exists()).toBe(false);
  });

  it('waits out a transient failure of the exact-id lookup instead of declaring the file gone', async() => {
    rootListing();
    let calls = 0;
    f.metadata.set('audit-report', () => (++calls === 1 ? Promise.reject(shuttingDown()) : Promise.resolve(record('audit-report', NESTED))));
    const wrapper = open('audit-report', NESTED);
    await flushPromises();
    expect(wrapper.text()).not.toContain('This file is no longer available');
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(shown(wrapper)).toMatchObject({ id: 'audit-report', path: NESTED });
  });

  it('stops after a bounded wait and offers an accessible Retry that opens the document once Files is ready', async() => {
    const load = vi.spyOn(DesktopFilesDataSource.prototype, 'load').mockRejectedValue(shuttingDown());
    f.metadata.set('audit-report', () => Promise.resolve(record('audit-report', NESTED)));
    const wrapper = open('audit-report', NESTED);
    await vi.advanceTimersByTimeAsync(120_000);
    await flushPromises();
    const attempts = load.mock.calls.length;
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThan(10);
    expect(status(wrapper).exists()).toBe(false);
    expect(retryButton(wrapper)?.attributes('type')).toBe('button');
    // Exhausted: no further automatic attempts.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(load).toHaveBeenCalledTimes(attempts);

    load.mockResolvedValue(snapshot());
    await retryButton(wrapper)!.trigger('click');
    await flushPromises();
    expect(shown(wrapper)).toMatchObject({ id: 'audit-report', path: NESTED });
    expect(retryButton(wrapper)).toBeUndefined();
  });

  it.each([
    ['a missing file', () => undefined],
    ['a deleted file', () => f.metadata.set('audit-report', () => Promise.resolve(record('audit-report', 'Reports/a.md', { deleted_at: '2026-11-17T12:30:00Z' })))],
  ])('does not wait or offer Retry for %s', async(_label, arrange) => {
    const load = rootListing();
    arrange();
    const wrapper = open('audit-report', 'Reports/a.md');
    await flushPromises();
    expect(wrapper.text()).toContain('This file is no longer available');
    expect(status(wrapper).exists()).toBe(false);
    expect(retryButton(wrapper)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not retry a permission failure', async() => {
    const load = vi.spyOn(DesktopFilesDataSource.prototype, 'load')
      .mockRejectedValue(new Error("Error invoking remote method 'sulla-files:collections': Error: 403 You do not have access to this collection"));
    const wrapper = open('audit-report', NESTED);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('You do not have access');
    expect(status(wrapper).exists()).toBe(false);
    expect(retryButton(wrapper)).toBeUndefined();
  });

  it('never paints the waiting document after a switch to another document', async() => {
    const load = vi.spyOn(DesktopFilesDataSource.prototype, 'load').mockRejectedValueOnce(shuttingDown()).mockResolvedValue(snapshot());
    f.metadata.set('first-report', () => Promise.resolve(record('first-report', 'Reports/first.md')));
    f.metadata.set('second-report', () => Promise.resolve(record('second-report', 'Reports/second.md')));
    const wrapper = open('first-report', 'Reports/first.md');
    await flushPromises();
    expect(status(wrapper).exists()).toBe(true);
    await wrapper.setProps({ documentFile: { fileId: 'second-report', path: 'Reports/second.md', collectionId: COLLECTION } });
    await flushPromises();
    expect(shown(wrapper)).toMatchObject({ id: 'second-report' });
    const settled = load.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    await flushPromises();
    expect(shown(wrapper)).toMatchObject({ id: 'second-report' });
    expect(load).toHaveBeenCalledTimes(settled);
  });

  it('stops waiting when the tab is closed', async() => {
    const load = vi.spyOn(DesktopFilesDataSource.prototype, 'load').mockRejectedValue(shuttingDown());
    const wrapper = open('audit-report', NESTED);
    await flushPromises();
    mounted.splice(mounted.indexOf(wrapper), 1);
    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
