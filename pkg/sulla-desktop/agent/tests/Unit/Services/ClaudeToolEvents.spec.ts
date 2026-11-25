// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { expect, it } from 'vitest';

import { ClaudeToolEventTracker } from '@pkg/agent/languagemodels/claudeToolEvents';

// risk: trace accuracy — Claude tool_use/tool_result correlation must emit the complete input, output and error.
it('forwards the complete Claude tool result once from its correlated runtime events', () => {
  const starts: unknown[] = [];
  const results: unknown[] = [];
  const timings: unknown[] = [];
  let now = 1_000;
  const tracker = new ClaudeToolEventTracker({
    onToolStarted: event => starts.push(event),
    onToolEvent: event => results.push(event),
  }, () => now, (name, ms, chars) => timings.push([name, ms, chars]));
  const input = { command: `FULL_CLAUDE_COMMAND:${ 'x'.repeat(400) }` };
  const result = [{ type: 'text', text: `FULL_CLAUDE_RESULT:${ 'y'.repeat(12_000) }` }];

  tracker.noteStart('claude-tool-call', 'Bash', input);
  tracker.noteStart('claude-tool-call', 'Bash', { command: 'duplicate must not replace the first input' });
  now += 27;
  tracker.noteResult('claude-tool-call', result, true);
  tracker.noteResult('unknown-tool-call', 'must not emit without a matching start');

  expect(starts).toEqual([{ toolUseId: 'claude-tool-call', toolName: 'Bash', input }]);
  expect(results).toEqual([expect.objectContaining({
    toolUseId: 'claude-tool-call', toolName: 'Bash', input, result: undefined,
    error: JSON.stringify(result, null, 2), resultChars: JSON.stringify(result, null, 2).length, isError: true,
  })]);
  expect(timings).toEqual([['Bash', 27, JSON.stringify(result, null, 2).length]]);
  expect(tracker.totals.get('Bash')).toEqual({ count: 1, ms: 27 });
});
