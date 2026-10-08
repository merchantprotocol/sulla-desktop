import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import {
  isInsideLogsDir, parseConversationLog, readConversationLog, readConversationPreview, toEntry,
} from '../agentConversationLog';

const lines = [
  { ts: '2026-10-07T22:10:49.556Z', type: 'graph_started', agentName: 'Codex SOL Worker', agentId: 'codex-sol-worker' },
  { ts: '2026-10-07T22:10:49.559Z', type: 'message', role: 'user', content: 'Audit the migration.' },
  { ts: '2026-10-07T22:10:49.893Z', type: 'VOICE:LLM:STREAM_START', mode: 'text', model: 'gpt-5.6-sol' },
  { ts: '2026-10-07T22:11:49.797Z', type: 'tool_call', toolName: 'command_execution', args: { command: 'git status' }, result: { chars: 147 } },
  { ts: '2026-10-07T22:12:00.000Z', type: 'message', role: 'assistant', content: 'Found **two** problems.' },
  { ts: '2026-10-07T22:12:01.000Z', type: 'graph_completed', status: 'completed', iterations: 3 },
].map(l => JSON.stringify(l)).join('\n');

describe('agentConversationLog', () => {
  let dir: string;
  let logsDir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-conv-'));
    logsDir = path.join(dir, 'logs');
    fs.mkdirSync(logsDir);
    fs.writeFileSync(path.join(logsDir, 'conv_a.jsonl'), `${ lines }\nnot json\n`);
    fs.writeFileSync(path.join(dir, 'outside.jsonl'), lines);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('maps messages, tool calls and start/finish markers and drops stream noise', () => {
    const { entries, truncated } = parseConversationLog(`${ lines }\n{broken`);

    expect(truncated).toBe(false);
    expect(entries.map(e => e.kind)).toEqual(['event', 'user', 'tool', 'assistant', 'event']);
    expect(entries[0].text).toBe('Started — Codex SOL Worker');
    expect(entries[2].toolName).toBe('command_execution');
    expect(entries[2].text).toContain('git status');
    expect(entries[4].text).toBe('Finished — completed');
  });

  it('keeps only the most recent entries past the cap', () => {
    const { entries, truncated } = parseConversationLog(lines, 2);

    expect(truncated).toBe(true);
    expect(entries.map(e => e.kind)).toEqual(['assistant', 'event']);
  });

  it('ignores unknown event types', () => {
    expect(toEntry({ type: 'node_entered', ts: 'x' })).toBeNull();
    expect(toEntry(null)).toBeNull();
  });

  it('only reads log files inside the logs directory', async() => {
    expect(isInsideLogsDir(path.join(logsDir, 'conv_a.jsonl'), logsDir)).toBe(true);
    expect(isInsideLogsDir(path.join(logsDir, '..', 'outside.jsonl'), logsDir)).toBe(false);

    const outside = await readConversationLog(path.join(dir, 'outside.jsonl'), logsDir);

    expect(outside.missingLog).toBe(true);
    expect(outside.entries).toEqual([]);
  });

  it('reads a log file and its first user prompt', async() => {
    const file = path.join(logsDir, 'conv_a.jsonl');
    const log = await readConversationLog(file, logsDir);

    expect(log.missingLog).toBe(false);
    expect(log.entries).toHaveLength(5);
    expect(await readConversationPreview(file, logsDir)).toBe('Audit the migration.');
  });

  it('reports a missing file instead of throwing', async() => {
    const log = await readConversationLog(path.join(logsDir, 'gone.jsonl'), logsDir);

    expect(log.missingLog).toBe(true);
    expect(await readConversationPreview(null, logsDir)).toBe('');
  });
});
