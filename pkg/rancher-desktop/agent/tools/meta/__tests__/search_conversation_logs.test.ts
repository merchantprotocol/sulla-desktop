import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetFileAssociations: any = jest.fn(() => Promise.resolve({ log_file: null, training_file: null }));

jest.unstable_mockModule('../../../database/models/ConversationHistoryModel', () => ({
  ConversationHistoryModel: { getFileAssociations: mockGetFileAssociations },
}));

async function loadWorker() {
  const { SearchConversationLogsWorker } = await import('../search_conversation_logs');
  const w = new SearchConversationLogsWorker();
  w.name = 'search_conversation_logs';
  w.description = 'search_conversation_logs';
  w.schemaDef = {
    thread_id: { type: 'string', optional: true },
    keyword:   { type: 'string', optional: true },
    since:     { type: 'string', optional: true },
    days:      { type: 'number', optional: true },
    limit:     { type: 'number', optional: true },
  } as any;
  return w;
}

describe('SearchConversationLogsWorker', () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-log-search-'));
    fs.mkdirSync(path.join(tmpDir, 'logs'), { recursive: true });
    originalHome = process.env.SULLA_HOME_DIR;
    process.env.SULLA_HOME_DIR = tmpDir;
    mockGetFileAssociations.mockReset();
    mockGetFileAssociations.mockResolvedValue({ log_file: null, training_file: null });
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.SULLA_HOME_DIR;
    else process.env.SULLA_HOME_DIR = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function logsDir(): string {
    return path.join(tmpDir, 'logs');
  }

  function writeLog(name: string, content: string) {
    fs.writeFileSync(path.join(logsDir(), name), content);
  }

  it('resolves both the channel log and the jsonl stream for a thread id', async() => {
    writeLog('sulla-desktop_abc-123.log', 'line one\nline two\n');
    writeLog('conv_abc-123.jsonl', '{"type":"message"}\n');
    writeLog('mobile-relay_other-456.log', 'unrelated\n');

    const result = await (await loadWorker()).invoke({ thread_id: 'abc-123' });

    expect(result.success).toBe(true);
    expect(result.result).toContain('sulla-desktop_abc-123.log');
    expect(result.result).toContain('conv_abc-123.jsonl');
    expect(result.result).not.toContain('mobile-relay_other-456.log');
  });

  it('sanitizes the thread id the same way SullaLogger does when matching filenames', async() => {
    writeLog('sulla-desktop_weird_id_here.log', 'hello\n');

    const result = await (await loadWorker()).invoke({ thread_id: 'weird/id:here' });

    expect(result.success).toBe(true);
    expect(result.result).toContain('sulla-desktop_weird_id_here.log');
  });

  it('falls back to conversation_history.log_file when the filename does not match', async() => {
    writeLog('legacy-name.log', 'from db association\n');
    mockGetFileAssociations.mockResolvedValue({ log_file: 'legacy-name.log', training_file: null });

    const result = await (await loadWorker()).invoke({ thread_id: 'db-only-id' });

    expect(result.success).toBe(true);
    expect(result.result).toContain('legacy-name.log');
  });

  it('reports no files found for an unknown thread id', async() => {
    const result = await (await loadWorker()).invoke({ thread_id: 'does-not-exist' });

    expect(result.success).toBe(true);
    expect(result.result).toContain('No log files found');
  });

  it('excludes global non-thread-scoped logs from a directory-wide scan', async() => {
    writeLog('chat.log', 'global noise\n');
    writeLog('index.jsonl', 'global noise\n');
    writeLog('sulla-desktop_thread-1.log', 'real conversation\n');

    const result = await (await loadWorker()).invoke({});

    expect(result.success).toBe(true);
    expect(result.result).toContain('sulla-desktop_thread-1.log');
    expect(result.result).not.toContain('chat.log');
    expect(result.result).not.toContain('index.jsonl');
  });

  it('filters a directory-wide scan by recency window (days)', async() => {
    const recentPath = path.join(logsDir(), 'sulla-desktop_recent.log');
    const oldPath = path.join(logsDir(), 'sulla-desktop_old.log');
    fs.writeFileSync(recentPath, 'recent\n');
    fs.writeFileSync(oldPath, 'old\n');
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    fs.utimesSync(oldPath, new Date(tenDaysAgo), new Date(tenDaysAgo));

    const result = await (await loadWorker()).invoke({ days: 1 });

    expect(result.success).toBe(true);
    expect(result.result).toContain('sulla-desktop_recent.log');
    expect(result.result).not.toContain('sulla-desktop_old.log');
  });

  it('filters to matching content lines when keyword is provided', async() => {
    writeLog('sulla-desktop_thread-2.log', 'nothing interesting\nfound the FK-integrity bug\nmore noise\n');

    const result = await (await loadWorker()).invoke({ thread_id: 'thread-2', keyword: 'FK-integrity' });

    expect(result.success).toBe(true);
    expect(result.result).toContain('found the FK-integrity bug');
    expect(result.result).not.toContain('nothing interesting');
  });

  it('reports no matches when the keyword is not found', async() => {
    writeLog('sulla-desktop_thread-3.log', 'nothing relevant here\n');

    const result = await (await loadWorker()).invoke({ thread_id: 'thread-3', keyword: 'zzz-not-present' });

    expect(result.success).toBe(true);
    expect(result.result).toContain('No lines matching');
  });

  it('handles a missing log directory gracefully', async() => {
    fs.rmSync(logsDir(), { recursive: true, force: true });

    const result = await (await loadWorker()).invoke({ thread_id: 'anything' });

    expect(result.success).toBe(true);
    expect(result.result).toContain('does not exist yet');
  });
});
