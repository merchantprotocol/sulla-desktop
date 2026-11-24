// SPDX-License-Identifier: GPL-2.0-or-later

import '../../Support/TestHomeEnv';

import { expect, it } from 'vitest';

import { ToolExecutor, type ToolExecutorContext } from '@pkg/agent/controllers/ToolExecutor';
import type { BaseThreadState } from '@pkg/agent/nodes/Graph';

// risk: data accuracy — tool outputs must not be replaced by a size-limited preview before the chat event is sent.
it('sends the complete tool result and error through the WebSocket event', async() => {
  const deliveries: unknown[] = [];
  const executor = new ToolExecutor({} as ToolExecutorContext);
  Object.defineProperty(executor, 'dispatchToWebSocket', {
    configurable: true,
    value: async(_channel: string, message: unknown) => { deliveries.push(message); return true; },
  });
  const output = `FULL_TOOL_OUTPUT:${ 'x'.repeat(60_000) }`;
  const error = 'FULL_TOOL_ERROR';
  const state = { metadata: { wsChannel: 'fixture', threadId: 'fixture-thread' } } as BaseThreadState;

  await executor.emitToolResultEvent(state, 'fixture-tool-call', false, error, output);

  expect(deliveries).toHaveLength(1);
  expect(deliveries[0]).toMatchObject({
    type: 'progress',
    data: { phase: 'tool_result', toolRunId: 'fixture-tool-call', success: false, error, result: output },
  });
});

// risk: data accuracy — tool outputs over the former 5,000-character persistence cap must survive in saved agent state.
it('persists complete long tool output in the native tool-result message', async() => {
  const executor = new ToolExecutor({
    nodeId: 'fixture-node', nodeName: 'Fixture', currentNodeRunContext: null,
    wsChatMessage: async() => true, bumpStateVersion() {},
  });
  const state = { metadata: { threadId: 'fixture-thread' }, messages: [] } as unknown as BaseThreadState;
  const output = `FULL_PERSISTED_OUTPUT:${ 'x'.repeat(12_000) }:OUTPUT_END`;

  await executor.appendToolResultMessage(state, 'fixture_tool', {
    toolName: 'fixture_tool', toolCallId: 'fixture-call', success: true, result: output,
  });

  const saved = state.messages[0];
  expect(saved.content).toEqual([expect.objectContaining({
    type: 'tool_result', tool_use_id: 'fixture-call',
    content: `tool: fixture_tool\nresult:\n${ output }`,
  })]);
});

// risk: data accuracy — screenshots must not be dropped from persisted tool results when larger than the old inline limit.
it('persists the complete inline screenshot payload', async() => {
  const executor = new ToolExecutor({
    nodeId: 'fixture-node', nodeName: 'Fixture', currentNodeRunContext: null,
    wsChatMessage: async() => true, bumpStateVersion() {},
  });
  const state = { metadata: { threadId: 'fixture-thread' }, messages: [] } as unknown as BaseThreadState;
  const screenshotBase64 = 'FULL_SCREENSHOT:' + 'x'.repeat(500_001);

  await executor.appendToolResultMessage(state, 'fixture_screenshot', {
    toolName: 'fixture_screenshot', toolCallId: 'fixture-screenshot-call', success: true,
    result: { screenshotBase64, screenshotMediaType: 'image/png' },
  });

  const savedToolResult = state.messages[0].content[0] as any;
  expect(savedToolResult.content).toHaveLength(2);
  expect(savedToolResult.content[0]).toMatchObject({
    type: 'image', source: { media_type: 'image/png', data: screenshotBase64 },
  });
  expect(savedToolResult.content[1]).toMatchObject({ type: 'text', text: expect.stringContaining(screenshotBase64) });
});
