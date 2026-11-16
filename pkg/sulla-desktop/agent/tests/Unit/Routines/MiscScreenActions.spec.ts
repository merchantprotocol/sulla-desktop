// SPDX-License-Identifier: GPL-2.0-or-later
// Exercise actual page action bodies in an isolated context: no Electron,
// mounted media devices, database, or live user mutations.
import fs from 'node:fs';
import path from 'node:path';
import { transformSync } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';

const root = process.cwd();
const ref = <T>(value: T) => ({ value });

function action(file: string, name: string, context: Record<string, unknown>) {
  const source = fs.readFileSync(path.join(root, 'pkg/sulla-desktop/pages', file), 'utf8');
  const start = source.search(new RegExp(`^(?:async )?function ${ name }\\(`, 'm'));
  if (start < 0) throw new Error(`Action missing: ${ name }`);
  const end = source.indexOf('\n}', start) + 2;
  const code = transformSync(source.slice(start, end), { loader: 'ts', target: 'es2022' }).code;

  return new Function(...Object.keys(context), `${ code }; return ${ name };`)(...Object.values(context));
}

function historyContext(invoke = vi.fn()) {
  return {
    ipcRenderer: { invoke },
    historyError: ref(''),
    loadedHistoryContext: ref(JSON.stringify(['active', '', ''])),
    loading: ref(false),
    entries: ref([{ id: 'retained' }]),
    searchQuery: ref(''),
    filterType: ref(''),
    historyView: ref('active'),
    actionMenu: ref({ entry: { id: 'retained' } }),
    showClearConfirm: ref(true),
    loadHistory: vi.fn().mockResolvedValue(undefined),
  };
}

describe('miscellaneous screen error feedback', () => {
  it('retains loaded history when a refresh fails and exposes the failure', async() => {
    const context = historyContext(vi.fn().mockRejectedValue(new Error('offline')));
    await action('HistoryTab.vue', 'loadHistory', context)();
    expect(context.entries.value).toEqual([{ id: 'retained' }]);
    expect(context.historyError.value).toContain('offline');
    expect(context.loading.value).toBe(false);
  });

  it('does not present stale active rows under a failed archived view', async() => {
    const context = historyContext(vi.fn().mockRejectedValue(new Error('offline')));
    context.historyView.value = 'archived';
    await action('HistoryTab.vue', 'loadHistory', context)();
    expect(context.entries.value).toEqual([]);
    expect(context.historyError.value).toContain('offline');
  });

  it('does not report mutation success after a failed refresh', async() => {
    const context = historyContext(vi.fn().mockResolvedValue({ id: 'retained' }));
    context.loadHistory.mockImplementation(async() => { context.historyError.value = 'refresh unavailable' });
    expect(await action('HistoryTab.vue', 'patchEntry', context)({ id: 'retained' }, {})).toBe(false);
    expect(context.historyError.value).toBe('refresh unavailable');
  });

  it('reports rejected mutations without an unhandled rejection or reload', async() => {
    const context = historyContext(vi.fn().mockRejectedValue(new Error('write denied')));
    expect(await action('HistoryTab.vue', 'patchEntry', context)({ id: 'retained' }, { pinned: true })).toBe(false);
    expect(context.historyError.value).toContain('write denied');
    expect(context.loadHistory).not.toHaveBeenCalled();
  });

  it('does not report success for a missing conversation', async() => {
    const context = historyContext(vi.fn().mockResolvedValue(null));
    expect(await action('HistoryTab.vue', 'patchEntry', context)({ id: 'missing' }, {})).toBe(false);
    expect(context.historyError.value).toContain('no longer exists');
  });

  it('reloads only after an acknowledged clear', async() => {
    let resolve!: (value: unknown) => void;
    const context = historyContext(vi.fn(() => new Promise(r => { resolve = r })));
    const pending = action('HistoryTab.vue', 'clearHistory', context)('all');
    expect(context.loadHistory).not.toHaveBeenCalled();
    resolve({ success: true });
    await pending;
    expect(context.loadHistory).toHaveBeenCalledOnce();
    expect(context.showClearConfirm.value).toBe(false);
  });

  it('reports failed clear rather than masking it with a delayed reload', async() => {
    const context = historyContext(vi.fn().mockRejectedValue(new Error('database offline')));
    await action('HistoryTab.vue', 'clearHistory', context)('all');
    expect(context.historyError.value).toContain('database offline');
    expect(context.loadHistory).not.toHaveBeenCalled();
  });

  it('does not clear the archive undo affordance if undo fails', async() => {
    const undoArchive = ref({ entry: { id: 'retained' }, archived: false });
    await action('HistoryTab.vue', 'undoLastArchive', {
      undoArchive, patchEntry: vi.fn().mockResolvedValue(false),
    })();
    expect(undoArchive.value).not.toBeNull();
  });

  it('surfaces a rejected notes reveal in the Secretary notice', async() => {
    const captureWarning = ref('');
    await action('SecretaryMode.vue', 'revealNotes', {
      savedNotesPath: ref('/synthetic/notes.md'), captureWarning,
      ipcRenderer: { invoke: vi.fn().mockRejectedValue(new Error('not found')) },
    })();
    expect(captureWarning.value).toContain('not found');
  });

  it('surfaces failed browser navigation without a blocking alert', async() => {
    const browserActionError = ref('');
    const loading = ref(true);
    action('BrowserTab.vue', 'reload', {
      browserActionError, loading, props: { tabId: 'synthetic' },
      ipcRenderer: { invoke: vi.fn().mockRejectedValue(new Error('view unavailable')) },
    })();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(browserActionError.value).toContain('view unavailable');
    expect(loading.value).toBe(false);
  });
});

describe('history IPC acknowledgements', () => {
  function captureHandlers(clearHistory = vi.fn().mockResolvedValue([])) {
    const handlers = new Map<string, (...args: any[]) => any>();
    const emit = vi.fn();
    const modules: Record<string, any> = {
      electron: { ipcMain: { on: vi.fn(), handle: (name: string, fn: any) => handlers.set(name, fn) } },
      'node:fs': { promises: { unlink: vi.fn() } },
      '@pkg/agent/database/PostgresClient': { postgresClient: {} },
      '@pkg/agent/database/models/ConversationHistoryModel': { ConversationHistoryModel: { clearHistory } },
      '@pkg/main/DatabaseReadGuard': { getDatabaseReadGuard: () => ({ run: vi.fn().mockRejectedValue(new Error('invalid query')) }) },
      '@pkg/main/mainEvents': { emit, on: vi.fn() },
      '@pkg/main/sync/syncQueue': { enqueueSyncOp: vi.fn() },
      '@pkg/utils/logging': { background: { log: vi.fn(), error: vi.fn() } },
    };
    const source = fs.readFileSync(path.join(root, 'pkg/sulla-desktop/main/conversationHistoryIpc.ts'), 'utf8');
    const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
    const module = { exports: {} as any };
    new Function('require', 'module', 'exports', code)((name: string) => {
      if (!(name in modules)) throw new Error(`Unexpected dependency: ${ name }`);

      return modules[name];
    }, module, module.exports);
    module.exports.initConversationHistoryIpc();

    return { handlers, emit };
  }

  it('acknowledges clear only when storage succeeds', async() => {
    const { handlers, emit } = captureHandlers();
    expect(await handlers.get('conversation-history:clear-confirmed')!({}, undefined)).toEqual({ success: true });
    expect(emit).toHaveBeenCalledWith('conversation-history:changed');
  });

  it('rejects a failed clear without broadcasting success', async() => {
    const context = captureHandlers(vi.fn().mockRejectedValue(new Error('storage offline')));
    await expect(context.handlers.get('conversation-history:clear-confirmed')!({}, undefined)).rejects.toThrow('storage offline');
    expect(context.emit).not.toHaveBeenCalled();
  });

  it('propagates real search errors instead of returning an empty result', async() => {
    const context = captureHandlers();
    await expect(context.handlers.get('conversation-history:search')!({}, 'query')).rejects.toThrow('invalid query');
  });
});
