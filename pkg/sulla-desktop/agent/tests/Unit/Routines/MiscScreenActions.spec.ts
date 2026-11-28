// SPDX-License-Identifier: GPL-2.0-or-later
// Exercise actual page action bodies in an isolated context: no Electron,
// mounted media devices, database, or live user mutations.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { transformSync } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FallbackThreadStateRepository, FileThreadCheckpointRepository, MemoryThreadStateRepository,
  RedisThreadStateRepository,
} from '../../../app/Repositories/ThreadStateRepository';
import { ConversationHistoryModel } from '../../../database/models/ConversationHistoryModel';

import type { BaseThreadState } from '../../../nodes/Graph';

const pg = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock('../../../database/PostgresClient', () => ({ postgresClient: pg }));

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
  function captureHandlers(clearHistory: typeof ConversationHistoryModel.clearHistory = vi.fn().mockResolvedValue([]),
    repository?: FallbackThreadStateRepository, unlink = fs.promises.unlink) {
    const handlers = new Map<string, (...args: any[]) => any>();
    const emit = vi.fn();
    const modules: Record<string, any> = {
      electron:                                              { ipcMain: { on: vi.fn(), handle: (name: string, fn: any) => handlers.set(name, fn) } },
      'node:fs':                                             { promises: { unlink } },
      '@pkg/agent/app/Providers/ThreadStateServiceProvider': { threadStateProvider: { repository } },
      '@pkg/agent/database/PostgresClient':                  { postgresClient: {} },
      '@pkg/agent/database/models/ConversationHistoryModel': { ConversationHistoryModel: { clearHistory } },
      '@pkg/main/DatabaseReadGuard':                         { getDatabaseReadGuard: () => ({ run: vi.fn().mockRejectedValue(new Error('invalid query')) }) },
      '@pkg/main/mainEvents':                                { emit, on: vi.fn() },
      '@pkg/main/sync/syncQueue':                            { enqueueSyncOp: vi.fn() },
      '@pkg/utils/logging':                                  { background: { log: vi.fn(), error: vi.fn() } },
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

  describe('checkpoint clear boundaries', () => {
    let dir: string;
    let store: string;
    let now: number;
    let rows: { id: string; thread_id: string; type: string; log_file: string }[];
    let rejectCommit: boolean;
    let boundary: (step: string) => Promise<void>;
    const keys = new Map<string, { json: string; expires: number }>();
    const client = {
      status: 'ready',
      ping:   () => Promise.resolve('PONG'),
      get:    (key: string) => {
        const entry = keys.get(key);
        return Promise.resolve(entry && entry.expires > now ? entry.json : null);
      },
      setex: async(key: string, ttl: number, json: string) => {
        await boundary('before SETEX');
        keys.set(key, { json, expires: now + ttl * 1000 });
        await boundary('after SETEX');
      },
      del: (key: string) => Promise.resolve(keys.delete(key)),
    };
    const boot = () => new FallbackThreadStateRepository(
      new RedisThreadStateRepository({ getClient: () => client }, 3600, new FileThreadCheckpointRepository(() => store)),
      new MemoryThreadStateRepository(), new MemoryThreadStateRepository(), console,
    );
    const state = (threadId: string, content: string) => ({
      metadata: { threadId }, messages: [{ role: 'user', content }],
    } as BaseThreadState);
    const big = 'x'.repeat(1024 * 1024);
    const clear = (repo = boot(), cutoff?: string) => {
      const { handlers } = captureHandlers(ConversationHistoryModel.clearHistory, repo, async(file) => {
        await fs.promises.unlink(file);
        await boundary('log');
      });
      return handlers.get('conversation-history:clear-confirmed')!({}, cutoff);
    };
    beforeEach(async() => {
      dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'history-clear-'));
      store = path.join(dir, 'checkpoints');
      now = Date.now();
      rows = [];
      rejectCommit = false;
      boundary = async() => {};
      keys.clear();
      const execute = (pending: typeof rows, sql: string, args: unknown[]) => {
        if (sql.includes('DELETE FROM')) {
          const deleted = pending.filter(row => !args.length || row.id !== 'retained');
          pending.splice(0, pending.length, ...pending.filter(row => !deleted.includes(row)));
          return deleted;
        }
        if (sql.includes('SELECT DISTINCT')) return pending.map(row => ({ thread: row.thread_id }));
        throw new Error('Unexpected statement');
      };
      const commit = async(pending: typeof rows) => {
        if (rejectCommit) throw new Error('commit rejected');
        rows = pending;
        await boundary('commit');
      };
      // Emulate both pg autocommit and an explicit transaction; SQL effects are
      // invisible outside the connection until its commit succeeds.
      pg.query.mockImplementation(async(sql, args = []) => {
        const pending = [...rows];
        const result = execute(pending, sql, args);
        if (/DELETE FROM/.test(sql)) await commit(pending);
        return result;
      });
      pg.transaction.mockImplementation(async(body) => {
        const pending = [...rows];
        const result = await body({ query: (sql: string, args: unknown[] = []) => Promise.resolve({ rows: execute(pending, sql, args) }) });
        await commit(pending);
        return result;
      });
    });
    afterEach(async() => {
      await fs.promises.rm(dir, { recursive: true, force: true });
    });

    async function seed(id: string, thread = id) {
      const log = path.join(dir, id + '.jsonl');
      await fs.promises.writeFile(log, 'transcript');
      rows.push({ id, thread_id: thread, type: 'chat', log_file: log });
      await boot().save(state(thread, big));
    }

    it('R1: preserves both logs, checkpoints and rows when commit fails', async() => {
      await seed('a');
      await seed('b');
      rejectCommit = true;
      await expect(clear()).resolves.toEqual({ success: true });
      expect(rows.map(row => row.id)).toEqual(['a', 'b']);
      for (const row of rows) {
        expect(fs.existsSync(row.log_file)).toBe(true);
        expect((await boot().load(row.id))?.messages[0].content === big).toBe(true);
      }
    });

    it('preserves thread state referenced by a retained row of a partial clear', async() => {
      await seed('gone');
      await seed('removed-tab', 'shared');
      await seed('retained', 'shared');
      await clear(boot(), '2026-01-01');
      expect(rows.map(row => row.id)).toEqual(['retained']);
      expect(fs.existsSync(path.join(dir, 'gone.jsonl'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'retained.jsonl'))).toBe(true);
      expect((await boot().load('shared'))?.messages[0].content === big).toBe(true);
    });

    it('R2: a non-directory checkpoint parent cannot abort clear or break a fresh load', async() => {
      await seed('gone');
      await fs.promises.rename(store, store + '-hidden');
      await fs.promises.writeFile(store, '');
      await expect(clear()).resolves.toEqual({ success: true });
      expect(rows).toEqual([]);
      expect(await boot().load('gone')).toBeNull();
    });

    it('expires the latest oversized save after ENOTDIR, even across an acknowledged clear', async() => {
      const repo = boot();
      const log = path.join(dir, 'thread.jsonl');

      await fs.promises.writeFile(log, 'transcript');
      rows.push({ id: 'tab', thread_id: 'thread', type: 'chat', log_file: log });
      await repo.save(state('thread', 'inline'));
      await fs.promises.writeFile(store, '');
      await repo.save(state('thread', big));
      expect.soft((await repo.load('thread'))?.messages[0].content === big).toBe(true);
      expect.soft(await boot().load('thread') === null).toBe(true);
      now += 3_601_000;
      expect.soft(await repo.load('thread') === null).toBe(true);
      await expect(clear(repo)).resolves.toEqual({ success: true });
      expect(rows).toEqual([]);
      expect(fs.existsSync(log)).toBe(false);
      expect(await repo.load('thread') === null).toBe(true);
    });

    it('R3: newer Redis wins after restart and neither tier resurfaces after expiry', async() => {
      const repo = boot();
      await repo.save(state('thread', big));
      await fs.promises.rename(store, store + '-hidden');
      await fs.promises.writeFile(store, '');
      await repo.save(state('thread', 'newer'));
      await fs.promises.unlink(store);
      await fs.promises.rename(store + '-hidden', store);
      expect((await boot().load('thread'))?.messages[0].content === 'newer').toBe(true);
      now += 3_601_000;
      expect(await boot().load('thread')).toBeNull();
      expect(await repo.load('thread')).toBeNull();
    });

    it.each(['ping', 'del'] as const)('R4: a ready Redis with stuck %s cannot stall acknowledgement', async(method) => {
      await seed('gone');
      const hung = vi.spyOn(client, method).mockImplementation(() => new Promise<never>(() => {}));
      try {
        await expect(clear()).resolves.toEqual({ success: true });
        expect(rows).toEqual([]);
        expect(hung).not.toHaveBeenCalled();
      } finally {
        hung.mockRestore();
      }
    }, 1700);

    it.each(['commit', 'log'])('crash after %s: fresh readers never restore expired state', async(step) => {
      await seed('gone');

      let reached!: () => void;
      const stopped = new Promise<void>(resolve => { reached = resolve });
      boundary = async(current) => {
        if (current !== step) return;
        reached();
        // Lose the reply/continuation after the real effect. Restart without
        // unwinding or running subsequent cleanup on the abandoned instance.
        await new Promise<never>(() => {});
      };
      await Promise.race([stopped, clear().then(() => { throw new Error('clear boundary not reached') })]);
      expect(rows).toEqual([]);
      expect(fs.existsSync(path.join(dir, 'gone.jsonl'))).toBe(step === 'commit');
      expect((await boot().load('gone'))?.messages[0].content === big).toBe(true);
      now += 3_601_000;
      expect(await boot().load('gone')).toBeNull();
    });
    it.each(['before rename', 'before SETEX', 'after SETEX'])('reopens safely at interrupted publication: %s', async(step) => {
      const repo = boot();
      await repo.save(state('thread', 'old' + big));
      let reached!: () => void;
      let resume!: () => void;
      const parked = new Promise<void>(resolve => { reached = resolve });
      const gate = new Promise<void>(resolve => { resume = resolve });
      boundary = async(current) => {
        if (current === step) {
          reached();
          await gate;
        }
      };
      // Pause the real rename, do not replace its result or fabricate a file.
      const rename = fs.promises.rename.bind(fs.promises);
      const hook = vi.spyOn(fs.promises, 'rename').mockImplementation(async(from, to) => {
        await boundary('before rename');
        return rename(from, to);
      });
      const save = repo.save(state('thread', 'new' + big));
      try {
        await Promise.race([parked, save.then(() => { throw new Error('publication boundary not reached') })]);
        const expected = step === 'after SETEX' ? 'new' : 'old';
        expect((await boot().load('thread'))?.messages[0].content === expected + big).toBe(true);
        keys.clear(); // Redis restarted; no on-disk artifact can become the head.
        expect(await boot().load('thread')).toBeNull();
      } finally {
        resume();
        await save;
        hook.mockRestore();
      }
    });
  });

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
