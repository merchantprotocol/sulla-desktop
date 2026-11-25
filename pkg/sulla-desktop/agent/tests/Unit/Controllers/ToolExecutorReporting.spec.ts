// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import '../../Support/TestHomeEnv';

import { expect, it, vi } from 'vitest';

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

// risk: context cost — model-bound results must retain the existing 5,000-character cap.
it('caps long model-bound tool output at 5,000 characters while chat events remain full', async() => {
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
    content: `tool: fixture_tool\nresult:\n${ output.slice(0, 5000) }...`,
  })]);
  expect(saved.content[0].content).not.toContain('OUTPUT_END');
});

// risk: context cost — screenshots above the 500 KB model cap use text fallback instead of inline image data.
it('keeps a 600 KB screenshot on the chat path but falls back to the model text reference', async() => {
  const executor = new ToolExecutor({
    nodeId: 'fixture-node', nodeName: 'Fixture', currentNodeRunContext: null,
    wsChatMessage: async() => true, bumpStateVersion() {},
  });
  const state = { metadata: { threadId: 'fixture-thread' }, messages: [] } as unknown as BaseThreadState;
  const screenshotBase64 = 'FULL_SCREENSHOT:' + 'x'.repeat(600_000);
  const fullResult = { text: 'Screenshot reference: /tmp/fixture-screenshot.png', screenshotBase64, screenshotMediaType: 'image/png' };
  const deliveries: unknown[] = [];
  Object.defineProperty(executor, 'dispatchToWebSocket', {
    configurable: true,
    value: async(_channel: string, message: unknown) => { deliveries.push(message); return true; },
  });
  const stateWithChannel = { metadata: { wsChannel: 'fixture', threadId: 'fixture-thread' }, messages: [] } as unknown as BaseThreadState;

  await executor.emitToolResultEvent(stateWithChannel, 'fixture-screenshot-call', true, undefined, fullResult);
  await executor.appendToolResultMessage(state, 'fixture_screenshot', {
    toolName: 'fixture_screenshot', toolCallId: 'fixture-screenshot-call', success: true,
    result: fullResult,
  });

  const modelToolResult = state.messages[0].content[0] as any;
  expect(typeof modelToolResult.content).toBe('string');
  expect(modelToolResult.content).toContain('Screenshot reference: /tmp/fixture-screenshot.png');
  expect(modelToolResult.content).toContain('[screenshot dropped: 600016 bytes exceeds inline cap');
  expect(modelToolResult.content).not.toContain(screenshotBase64);
  expect(deliveries[0]).toMatchObject({
    type: 'progress', data: { phase: 'tool_result', result: fullResult },
  });
});
