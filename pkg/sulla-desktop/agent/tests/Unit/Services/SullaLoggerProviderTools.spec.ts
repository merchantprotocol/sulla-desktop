// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { appendFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

import { ConversationHistoryModel } from '@pkg/agent/database/models/ConversationHistoryModel';
import { SullaLogger } from '@pkg/agent/services/SullaLogger';
import type { ConversationEventAppender } from '@pkg/agent/services/ConversationEventAppender';

// risk: secret exposure — provider MCP aliases must hit the existing vault-argument log redaction policy.
it('normalizes MCP and server-prefixed provider names before redacting logged args', async() => {
  const home = await mkdtemp(path.join(tmpdir(), 'sulla-provider-log-'));
  const previousHome = process.env.SULLA_HOME_DIR;
  const updateActivity = vi.spyOn(ConversationHistoryModel, 'updateActivity').mockResolvedValue(undefined);
  const getFileAssociations = vi.spyOn(ConversationHistoryModel, 'getFileAssociations').mockImplementation(async(id: string) => ({ log_file: id === 'provider-logs' ? path.join(home, 'logs', 'conv_provider-logs.jsonl') : null }));
  try {
    process.env.SULLA_HOME_DIR = home;
    const logger = new SullaLogger();
    expect(await logger.logToolCall('provider-logs', 'mcp__sulla-native__vault_set_credential', { value: 'SYNTHETIC_SECRET_ONE', safe: 'visible' }, 'result-one', 'call-one')).toBe(true);
    expect(await logger.logToolCall('provider-logs', 'github/vault_set_credential', { value: 'SYNTHETIC_SECRET_TWO', safe: 'visible' }, 'result-two', 'call-two')).toBe(true);

    const contents = await readFile(path.join(home, 'logs', 'conv_provider-logs.jsonl'), 'utf8');
    const events = contents.trim().split('\n').map(line => JSON.parse(line));
    expect(events).toEqual([
      expect.objectContaining({ toolName: 'mcp__sulla-native__vault_set_credential', args: { value: '[REDACTED]', safe: 'visible' }, result: 'result-one', toolCallId: 'call-one' }),
      expect.objectContaining({ toolName: 'github/vault_set_credential', args: { value: '[REDACTED]', safe: 'visible' }, result: 'result-two', toolCallId: 'call-two' }),
    ]);
    expect(contents).not.toContain('SYNTHETIC_SECRET_ONE');
    expect(contents).not.toContain('SYNTHETIC_SECRET_TWO');
  } finally {
    updateActivity.mockRestore();
    getFileAssociations.mockRestore();
    if (previousHome === undefined) delete process.env.SULLA_HOME_DIR;
    else process.env.SULLA_HOME_DIR = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

// risk: data loss — the renderer may only drop a large result after both the JSONL append and its thread association are confirmed.
it('reports false when the write fails or its durable log association is missing', async() => {
  const home = await mkdtemp(path.join(tmpdir(), 'sulla-provider-log-confirmation-'));
  const previousHome = process.env.SULLA_HOME_DIR;
  const updateActivity = vi.spyOn(ConversationHistoryModel, 'updateActivity').mockResolvedValue(undefined);
  const getFileAssociations = vi.spyOn(ConversationHistoryModel, 'getFileAssociations').mockResolvedValue({ log_file: null });
  const loggerErrors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    process.env.SULLA_HOME_DIR = home;
    const appender: ConversationEventAppender = {
      append(filePath, contents) {
        if (filePath.endsWith('conv_write-fail.jsonl')) throw new Error('synthetic append failure');
        appendFileSync(filePath, contents, 'utf-8');
      },
    };
    const logger = new SullaLogger(appender);
    expect(await logger.logToolCall('no-association', 'exec', { command: 'echo safe' }, 'full result', 'call-no-association')).toBe(false);

    getFileAssociations.mockResolvedValue({ log_file: path.join(home, 'logs', 'conv_write-fail.jsonl') });
    expect(await logger.logToolCall('write-fail', 'exec', { command: 'echo safe' }, 'full result', 'call-write-fail')).toBe(false);

    getFileAssociations.mockResolvedValue({ log_file: path.join(home, 'logs', 'conv_associated.jsonl') });
    expect(await logger.logToolCall('associated', 'exec', { command: 'echo safe' }, 'full result', 'call-associated')).toBe(true);
  } finally {
    loggerErrors.mockRestore();
    updateActivity.mockRestore();
    getFileAssociations.mockRestore();
    if (previousHome === undefined) delete process.env.SULLA_HOME_DIR;
    else process.env.SULLA_HOME_DIR = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
