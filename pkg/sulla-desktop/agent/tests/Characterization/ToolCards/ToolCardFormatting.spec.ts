// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatToolCard, formatToolResult, redactToolArgs } from '../../../tools/toolCardFormatters';

const secretTools = [
  ['vault_create_password', 'password'],
  ['vault_update_password', 'password'],
  ['vault_set_credential', 'value'],
] as const;
const knownTools = [
  'exec', 'exechost', 'file_search', 'read_file', 'browser_tab', 'click_element', 'set_field',
  'git_status', 'git_commit', 'github_create_pr', 'docker_build', 'slack_send_message',
  'pg_query', 'redis_get', 'calendar_create', 'execute_workflow', 'install_extension',
  'spawn_agent', 'send_notification_to_human', 'add_observational_memory', 'create_workspace',
  'create_skill', 'integration_list', 'vault_is_enabled',
];

describe('tool card formatting characterization', () => {
  it('redacts every vault secret while preserving non-secret fields', () => {
    fc.assert(fc.property(fc.string({ minLength: 1 }), fc.string(), (secret, safe) => {
      for (const [toolName, field] of secretTools) {
        const args = { [field]: secret, safe };
        const redacted = redactToolArgs(toolName, args) as Record<string, unknown>;
        expect(redacted[field]).toBe('[REDACTED]');
        expect(redacted.safe).toBe(safe);
        expect(JSON.stringify(redacted)).not.toContain(secret);
        expect(JSON.stringify(formatToolCard(toolName, redacted))).not.toContain(secret);
      }
    }));
  });

  it('leaves non-object arguments unchanged', () => {
    for (const value of [null, undefined, 'secret', 3, true, [], ['secret']]) {
      expect(redactToolArgs('vault_set_credential', value)).toBe(value);
    }
  });

  it('resolves known tools distinctly and applies prefix or generic fallback', () => {
    for (const toolName of knownTools) {
      const display = formatToolCard(toolName, {});
      expect(display.summary).not.toBe(toolName.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));
    }
    expect(formatToolCard('fs_unknown_tool', {}).label).toBe('Files');
    expect(formatToolCard('mystery_tool', {}).label).toBe('Tool');
  });

  it('never throws and keeps rendered output bounded for arbitrary values', () => {
    fc.assert(fc.property(fc.anything(), fc.anything(), (args, result) => {
      const safeArgs = (args && typeof args === 'object' && !Array.isArray(args)) ? args as Record<string, unknown> : {};
      expect(() => formatToolCard('exec', safeArgs, result)).not.toThrow();
      expect(() => formatToolResult('exec', safeArgs, result)).not.toThrow();
      const card = formatToolCard('exec', safeArgs, result);
      expect(card.summary.length).toBeLessThanOrEqual(80);
      expect(card.input?.length ?? 0).toBeLessThanOrEqual(80);
    }), { numRuns: 100 });
  });
});
