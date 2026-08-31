/** @jest-environment node */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetByThread = jest.fn<any>();
const mockGetById = jest.fn<any>();
const mockLoadThreadState = jest.fn<any>();
const mockLoadThreadsByThreadId = jest.fn<any>();
const mockQuery = jest.fn<any>();

jest.unstable_mockModule('@pkg/agent/database/models/ConversationHistoryModel', () => ({
  ConversationHistoryModel: {
    getByThread: mockGetByThread,
    getById: mockGetById,
  },
}));
jest.unstable_mockModule('@pkg/agent/database/models/ChatMessageModel', () => ({
  ChatMessageModel: {
    loadThreadState: mockLoadThreadState,
    loadThreadsByThreadId: mockLoadThreadsByThreadId,
  },
}));
jest.unstable_mockModule('@pkg/agent/database/PostgresClient', () => ({
  postgresClient: { query: mockQuery },
}));

async function loadWorker() {
  const { SearchConversationsWorker } = await import('../search_conversations');
  const worker = new SearchConversationsWorker();
  worker.schemaDef = { action: { type: 'string', optional: true }, id: { type: 'string', optional: true }, threadId: { type: 'string', optional: true } };
  return worker;
}

describe('SearchConversationsWorker transcript recovery', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-search-conversations-'));
    mockGetByThread.mockReset();
    mockGetById.mockReset();
    mockLoadThreadState.mockReset().mockResolvedValue(null);
    mockLoadThreadsByThreadId.mockReset().mockResolvedValue([]);
    mockQuery.mockReset().mockResolvedValue([]);
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('falls back to conversation_history.log_file and includes messages plus tool events', async() => {
    const logFile = path.join(tmpDir, 'worker.jsonl');
    fs.writeFileSync(logFile, [
      JSON.stringify({ type: 'message', role: 'user', content: 'plan this' }),
      JSON.stringify({ type: 'tool_call', toolName: 'file_search' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'I found the relevant files.' }),
      JSON.stringify({ type: 'graph_completed', status: 'completed' }),
    ].join('\n') + '\n');
    mockGetByThread.mockResolvedValue({ title: 'Planner A', thread_id: 'worker-1', log_file: logFile, last_active_at: '2026-08-31T00:00:00.000Z' });

    const result = await (await loadWorker()).invoke({ action: 'messages', threadId: 'worker-1' });

    expect(result.success).toBe(true);
    expect(result.result).toContain('USER: plan this');
    expect(result.result).toContain('[tool_call: file_search]');
    expect(result.result).toContain('ASSISTANT: I found the relevant files.');
    expect(result.result).not.toContain('INCOMPLETE TRANSCRIPT');
  });

  it('reports a missing JSONL file as incomplete instead of claiming no failure', async() => {
    const missing = path.join(tmpDir, 'missing.jsonl');
    mockGetByThread.mockResolvedValue({ title: 'Planner B', thread_id: 'worker-2', log_file: missing });

    const result = await (await loadWorker()).invoke({ action: 'messages', threadId: 'worker-2' });

    expect(result.success).toBe(true);
    expect(result.result).toContain('Incomplete transcript');
    expect(result.result).toContain('log file is missing');
  });

  it('marks valid messages with malformed JSONL as incomplete', async() => {
    const logFile = path.join(tmpDir, 'partial.jsonl');
    fs.writeFileSync(logFile, '{"type":"message","role":"assistant","content":"partial"}\nnot-json\n');
    mockGetByThread.mockResolvedValue({ title: 'Planner C', thread_id: 'worker-3', log_file: logFile });

    const result = await (await loadWorker()).invoke({ action: 'messages', threadId: 'worker-3' });

    expect(result.success).toBe(true);
    expect(result.result).toContain('INCOMPLETE TRANSCRIPT');
    expect(result.result).toContain('ASSISTANT: partial');
    expect(result.result).toContain('1 malformed JSONL line');
  });
});
