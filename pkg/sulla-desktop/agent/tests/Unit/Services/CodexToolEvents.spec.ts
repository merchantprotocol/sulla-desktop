// SPDX-License-Identifier: GPL-2.0-or-later

import { expect, it } from 'vitest';

import { codexToolEventForItem, emitCodexToolEvent } from '@pkg/agent/languagemodels/codexToolEvents';

// risk: data accuracy — Codex command/MCP inputs, outputs and errors must reach chat without substitution or truncation.
it('forwards the full command and MCP tool payloads from completed Codex items', () => {
  const output = `FULL_CODEX_OUTPUT:${ 'x'.repeat(55_000) }`;
  const command = `FULL_CODEX_COMMAND:${ 'y'.repeat(300) }`;
  const commandItem = {
    item_type: 'command_execution', id: 'command-call', command, cwd: '/fixture',
    aggregated_output: output, stderr: 'FULL_CODEX_STDERR', exit_code: 1,
  };
  const commandEvent = codexToolEventForItem(commandItem);
  expect(commandEvent).toMatchObject({
    toolUseId: 'command-call', toolName: 'command_execution',
    input: { command, cwd: '/fixture' }, result: output, error: 'FULL_CODEX_STDERR', isError: true,
  });
  expect(commandEvent?.resultChars).toBe(output.length);

  const result = { content: 'FULL_MCP_RESULT', rows: [1, 2, 3] };
  const error = 'FULL_MCP_ERROR';
  const mcpItem = {
    item_type: 'mcp_tool_call', id: 'mcp-call', server: 'sulla', tool: 'memory_search',
    arguments: { query: 'FULL_MCP_ARGUMENT' }, result, error, status: 'failed',
  };
  const delivered: unknown[] = [];
  emitCodexToolEvent('item.completed', mcpItem, event => delivered.push(event));
  expect(delivered).toEqual([expect.objectContaining({
    toolUseId: 'mcp-call', toolName: 'sulla/memory_search',
    input: { query: 'FULL_MCP_ARGUMENT' }, result, error, isError: true,
  })]);
});
