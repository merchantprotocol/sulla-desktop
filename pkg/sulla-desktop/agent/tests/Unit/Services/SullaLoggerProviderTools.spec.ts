// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

import { ConversationHistoryModel } from '@pkg/agent/database/models/ConversationHistoryModel';
import { SullaLogger } from '@pkg/agent/services/SullaLogger';

// risk: secret exposure — provider MCP aliases must hit the existing vault-argument log redaction policy.
it('normalizes MCP and server-prefixed provider names before redacting logged args', async() => {
  const home = await mkdtemp(path.join(tmpdir(), 'sulla-provider-log-'));
  const previousHome = process.env.SULLA_HOME_DIR;
  const updateActivity = vi.spyOn(ConversationHistoryModel, 'updateActivity').mockResolvedValue(undefined);
  try {
    process.env.SULLA_HOME_DIR = home;
    const logger = new SullaLogger();
    logger.logToolCall('provider-logs', 'mcp__sulla-native__vault_set_credential', { value: 'SYNTHETIC_SECRET_ONE', safe: 'visible' }, 'result-one', 'call-one');
    logger.logToolCall('provider-logs', 'github/vault_set_credential', { value: 'SYNTHETIC_SECRET_TWO', safe: 'visible' }, 'result-two', 'call-two');

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
    if (previousHome === undefined) delete process.env.SULLA_HOME_DIR;
    else process.env.SULLA_HOME_DIR = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
