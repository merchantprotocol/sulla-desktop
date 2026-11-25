// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom

import '../../Support/TestHomeEnv';

import { expect, it, onTestFinished, vi } from 'vitest';
import { ref } from 'vue';

import { createMessageDispatcher } from '@pkg/agent/database/models/MessageDispatcher';
import type { ChatMessage } from '@pkg/agent/database/registry/AgentPersonaRegistry';
import { ToolExecutor, type ToolExecutorContext } from '@pkg/agent/controllers/ToolExecutor';
import type { BaseThreadState } from '@pkg/agent/nodes/Graph';
import { DetailedTraceProjection } from '@pkg/pages/chat/components/transcript/DetailedTraceProjection';
import { TranscriptReporting } from '@pkg/pages/chat/components/transcript/toolGroups';
import { ChatController } from '@pkg/pages/chat/controller/ChatController';
import type { Message } from '@pkg/pages/chat/models/Message';
import { PersonaAdapter } from '@pkg/pages/chat/services/PersonaAdapter';
import { asMessageId } from '@pkg/pages/chat/types/chat';

vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: vi.fn(), send: vi.fn(), sendSync: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }));
vi.mock('@pkg/pages/agent/ChatInterface', () => ({ ChatInterface: class {} }));

class ToolTranscriptFixture {
  readonly messages = ref<ChatMessage[]>([]).value;
  readonly graphRunning = ref(false);
  readonly currentActivity = ref('');
  readonly chat = new ChatController();
  readonly state = { metadata: { wsChannel: 'fixture-agent', threadId: 'fixture-thread' }, messages: [] } as unknown as BaseThreadState;
  readonly context = {
    messages: this.messages, graphRunning: this.graphRunning, currentActivity: this.currentActivity,
    toolRunIdToMessageId: new Map<string, string>(), registry: { setLoading() {} },
  };
  readonly dispatcher = createMessageDispatcher();
  readonly adapter = Object.create(PersonaAdapter.prototype);
  readonly executor: ToolExecutor;
  readonly reporting = new TranscriptReporting();

  constructor() {
    onTestFinished(() => this.chat.dispose());
    Object.assign(this.adapter, {
      controller: this.chat,
      ci: { messages: ref(this.messages), graphRunning: this.graphRunning, threadId: ref('fixture-thread') },
      seen: new Set(), seenRunning: new Set(), optimisticUserMessages: new Map(), pendingA2aStatuses: new Map(),
      firstSeenAt: new Map(), firstCompletedAt: new Map(), lastMappedHash: new Map(), lastRawSignature: new Map(),
      persistentArtifacts: new Set(),
    });
    this.executor = new ToolExecutor({
      nodeId: 'fixture-node', nodeName: 'Fixture', currentNodeRunContext: null,
      wsChatMessage: async() => true, bumpStateVersion() {},
    } as ToolExecutorContext);
    Object.defineProperty(this.executor, 'dispatchToWebSocket', {
      configurable: true,
      value: async(_channel: string, message: any) => {
        this.dispatcher.dispatch(this.context as any, 'fixture-agent', 'fixture-thread', message);
        this.adapter.syncMessages();
        return true;
      },
    });
  }

  async record(toolRunId: string, toolName: string, args: unknown, result: unknown, error?: string, payloadThreadId?: string): Promise<void> {
    await this.executor.emitToolCallEvent(this.state, toolRunId, toolName, args);
    const success = error === undefined;
    await this.executor.emitToolResultEvent(this.state, toolRunId, success, error, result, payloadThreadId);
    await this.executor.appendToolResultMessage(this.state, toolName, {
      toolName, toolCallId: toolRunId, success, error, result,
    });
  }
}

class ToolTranscriptMessages {
  standardProjection(): Message[] {
    return [
      { id: asMessageId('projection-user'), kind: 'user', createdAt: 1, text: 'hello' },
      { id: asMessageId('123_tool_exec'), kind: 'tool', createdAt: 2, recordedToolName: 'exec', tool: 'Bash', desc: 'Running command', status: 'ok', input: '{"command":"true"}', output: 'done' },
      { id: asMessageId('124_tool_background_browse'), kind: 'tool', createdAt: 3, recordedToolName: 'background_browse', tool: 'Browser', desc: '', status: 'error' },
      { id: asMessageId('123_tool_provider-run-1'), kind: 'tool', createdAt: 3.5, recordedToolName: 'github/search', providerTool: true, tool: 'Git', desc: 'Provider tool', status: 'ok', input: 'FULL_PROVIDER_INPUT', output: 'FULL_PROVIDER_OUTPUT' },
      { id: asMessageId('legacy-tool-id'), kind: 'tool', createdAt: 4, recordedToolName: 'vendor_action', tool: 'vendor_action', desc: '', status: 'ok', input: '{"x":1}' },
      { id: asMessageId('125_tool_vendor_action'), kind: 'tool', createdAt: 5, recordedToolName: 'vendor_action', tool: 'vendor_action', desc: '', status: 'ok', input: '{"x":2}' },
      { id: asMessageId('126_tool_running'), kind: 'tool', createdAt: 6, recordedToolName: 'exec', tool: 'Bash', desc: '', status: 'running' },
      { id: asMessageId('activity'), kind: 'thinking', createdAt: 7, thoughts: ['Preparing your turn…'], reportingActivity: 'status', startedAt: 7, completed: true },
    ];
  }

  detailedPayloads(): Message[] {
    return [
      { id: asMessageId('123_tool_exec'), kind: 'tool', createdAt: 1, recordedToolName: 'exec', tool: 'Bash', desc: 'Running command', status: 'ok', input: 'FULL_KNOWN_INPUT', output: 'FULL_KNOWN_OUTPUT', error: 'FULL_KNOWN_ERROR' },
      { id: asMessageId('124_tool_vendor'), kind: 'tool', createdAt: 2, recordedToolName: 'vendor/custom_action', tool: 'Vendor', desc: 'Custom action', status: 'error', input: 'FULL_UNKNOWN_INPUT', output: 'FULL_UNKNOWN_OUTPUT', error: 'FULL_UNKNOWN_ERROR' },
      { id: asMessageId('legacy-tool-id'), kind: 'tool', createdAt: 3, recordedToolName: 'legacy/untyped_action', tool: 'Legacy', desc: 'Legacy action', status: 'error', input: 'FULL_UNTYPED_INPUT', output: 'FULL_UNTYPED_OUTPUT', error: 'FULL_UNTYPED_ERROR' },
      { id: asMessageId('legacy-memory-call'), kind: 'tool', createdAt: 4, recordedToolName: 'episodic_search', tool: 'Memory', desc: 'Searching memory', status: 'error', input: 'FULL_MEMORY_INPUT', output: 'FULL_MEMORY_OUTPUT', error: 'FULL_MEMORY_ERROR' },
      { id: asMessageId('125_tool_background_browse'), kind: 'tool', createdAt: 5, recordedToolName: 'background_browse', tool: 'Browser', desc: 'Background browse', status: 'error', input: 'FULL_BACKGROUND_BROWSE_INPUT', output: 'FULL_BACKGROUND_BROWSE_OUTPUT', error: 'FULL_BACKGROUND_BROWSE_ERROR' },
      { id: asMessageId('provider_tool_item-7'), kind: 'tool', createdAt: 6, recordedToolName: 'github/search', providerTool: true, tool: 'GitHub', desc: 'Provider search', status: 'ok', input: 'FULL_PROVIDER_INPUT', output: 'FULL_PROVIDER_OUTPUT' },
    ];
  }
}

// risk: Standard layout/content drift — the expected projection was captured by executing the base implementation.
it('keeps Standard projection byte-identical to the base output for the same messages', () => {
  const reporting = new TranscriptReporting();
  const standard = reporting.entries(new ToolTranscriptMessages().standardProjection(), 'info');
  const generatedBaseOutput = '[{"id":"projection-user","sourceId":"projection-user","createdAt":1,"label":"Message","level":"info","essential":true,"kind":"card","message":{"id":"projection-user","kind":"user","createdAt":1,"text":"hello"}},{"id":"123_tool_exec","sourceId":"123_tool_exec","createdAt":2,"kind":"activity","label":"Tool","level":"info","text":"Shell · Completed"}]';
  expect(JSON.stringify(standard)).toBe(generatedBaseOutput);
  expect(reporting.standardEntries(new ToolTranscriptMessages().standardProjection(), 'debug')).toEqual(standard);
});

// risk: known, unknown and untyped tool identities or full payload fields disappear from Detailed disclosure.
it('adds every full tool payload to Detailed without a withheld placeholder in either view', () => {
  const messages = new ToolTranscriptMessages().detailedPayloads();
  const reporting = new TranscriptReporting();
  const standard = reporting.standardEntries(messages, 'info');
  const detailedEntries = reporting.entries(messages, 'debug');
  const rows = new DetailedTraceProjection().project(messages, standard).flatMap(turn => turn.rows).filter(row => row.kind === 'tool');
  expect(standard.filter(entry => entry.kind === 'activity').map(entry => entry.text)).toEqual(['Shell · Completed']);
  expect(detailedEntries.map(entry => entry.kind === 'activity' ? entry.text : '')).toEqual([
    'exec · ok', 'vendor/custom_action · error', 'legacy/untyped_action · error',
    'episodic_search · error', 'background_browse · error', 'github/search · ok',
  ]);
  expect(rows.map(row => row.target)).toEqual([
    'FULL_KNOWN_INPUT', 'vendor/custom_action', 'legacy/untyped_action', 'episodic_search', 'background_browse', 'github/search',
  ]);
  expect(rows.map(row => JSON.parse(row.payload!.serialize()))).toEqual([
    expect.objectContaining({ tool: 'exec', input: 'FULL_KNOWN_INPUT', output: 'FULL_KNOWN_OUTPUT', error: 'FULL_KNOWN_ERROR' }),
    expect.objectContaining({ tool: 'vendor/custom_action', input: 'FULL_UNKNOWN_INPUT', output: 'FULL_UNKNOWN_OUTPUT', error: 'FULL_UNKNOWN_ERROR' }),
    expect.objectContaining({ tool: 'legacy/untyped_action', input: 'FULL_UNTYPED_INPUT', output: 'FULL_UNTYPED_OUTPUT', error: 'FULL_UNTYPED_ERROR' }),
    expect.objectContaining({ tool: 'episodic_search', input: 'FULL_MEMORY_INPUT', output: 'FULL_MEMORY_OUTPUT', error: 'FULL_MEMORY_ERROR' }),
    expect.objectContaining({ tool: 'background_browse', input: 'FULL_BACKGROUND_BROWSE_INPUT', output: 'FULL_BACKGROUND_BROWSE_OUTPUT', error: 'FULL_BACKGROUND_BROWSE_ERROR' }),
    expect.objectContaining({ tool: 'github/search', input: 'FULL_PROVIDER_INPUT', output: 'FULL_PROVIDER_OUTPUT' }),
  ]);
  expect(JSON.stringify([standard, detailedEntries, rows.map(row => row.payload?.serialize())])).not.toMatch(/withheld/i);
});

// risk: memory/browser calls and failures disappearing before they reach the persisted Detailed trace.
it('keeps memory and background-browse inputs, results, and errors in live and saved Detailed rows', async() => {
  const fixture = new ToolTranscriptFixture();
  const memoryInput = { query: 'FULL_MEMORY_QUERY' };
  const memoryResult = { matches: ['FULL_MEMORY_MATCH'] };
  const browserInput = { url: 'https://fixture.invalid/FULL_BROWSER_URL' };
  const browserResult = { text: 'FULL_BROWSER_RESULT' };
  await fixture.record('memory-call', 'episodic_search', memoryInput, memoryResult, 'FULL_MEMORY_ERROR');
  await fixture.record('background-browse-call', 'background_browse', browserInput, browserResult, 'FULL_BROWSER_ERROR');

  const saved = JSON.parse(JSON.stringify(fixture.chat.serialize()));
  const reopened = new ChatController({ hydrateFrom: saved });
  onTestFinished(() => reopened.dispose());
  const messages = reopened.messages.value;
  const reporting = new TranscriptReporting();
  const standard = reporting.standardEntries(messages, 'info');
  const rows = new DetailedTraceProjection().project(messages, standard).flatMap(turn => turn.rows).filter(row => row.kind === 'tool');
  expect(rows.map(row => row.target)).toEqual(['episodic_search', 'background_browse']);
  expect(rows.map(row => JSON.parse(row.payload!.serialize()))).toEqual([
    expect.objectContaining({ tool: 'episodic_search', status: 'error', input: JSON.stringify(memoryInput, null, 2), output: JSON.stringify(memoryResult, null, 2), error: 'FULL_MEMORY_ERROR' }),
    expect.objectContaining({ tool: 'background_browse', status: 'error', input: JSON.stringify(browserInput, null, 2), output: JSON.stringify(browserResult, null, 2), error: 'FULL_BROWSER_ERROR' }),
  ]);
  expect(rows.every(row => row.status === 'failed')).toBe(true);
});

// risk: data loss — large results must reach the saved transcript in full while the model copy remains capped.
it('saves and reloads a 60 KB result while keeping the model-bound tool_result capped at 5,000 chars', async() => {
  const fixture = new ToolTranscriptFixture();
  const output = `OUTPUT_START:${ 'x'.repeat(60_000) }:OUTPUT_END`;
  const args = { command: 'echo full-output' };
  await fixture.record('full-output-call', 'exec', args, output);
  const live = fixture.chat.messages.value.find((message): message is Extract<Message, { kind: 'tool' }> => message.kind === 'tool')!;
  expect(live).toMatchObject({ recordedToolName: 'exec', input: JSON.stringify(args, null, 2), output });
  const modelToolResult = (fixture.state.messages[0] as any).content[0];
  expect(modelToolResult.content).toBe(`tool: exec\nresult:\n${ output.slice(0, 5000) }...`);
  expect(modelToolResult.content).not.toContain('OUTPUT_END');

  const snapshot = JSON.parse(JSON.stringify(fixture.chat.serialize()));
  const reopened = new ChatController({ hydrateFrom: snapshot });
  onTestFinished(() => reopened.dispose());
  const restored = reopened.messages.value.find((message): message is Extract<Message, { kind: 'tool' }> => message.kind === 'tool')!;
  expect(restored.output).toBe(output);
  const standard = fixture.reporting.standardEntries(reopened.messages.value, 'info');
  const trace = new DetailedTraceProjection().project(reopened.messages.value, standard).flatMap(turn => turn.rows).find(row => row.kind === 'tool')!;
  expect(JSON.parse(trace.payload!.serialize())).toMatchObject({ tool: 'exec', input: JSON.stringify(args, null, 2), output });
});

// risk: performance and image visibility — chat state must reference image bytes instead of persisting base64 text.
it('projects a 600 KB screenshot to a payload reference while the model receives only its text reference', async() => {
  const fixture = new ToolTranscriptFixture();
  const screenshot = `FULL_SCREENSHOT:${ 'x'.repeat(600_000) }`;
  const result = { text: 'Screenshot reference: /tmp/fixture-screenshot.png', screenshotBase64: screenshot, screenshotMediaType: 'image/png' };
  await fixture.record('screenshot-call', 'browser_screenshot', { tabId: 'fixture-tab' }, result, undefined, 'fixture-thread');
  const modelToolResult = (fixture.state.messages[0] as any).content[0];
  expect(modelToolResult.content).toContain('Screenshot reference: /tmp/fixture-screenshot.png');
  expect(modelToolResult.content).not.toContain(screenshot);
  expect(typeof modelToolResult.content).toBe('string');

  const snapshot = JSON.parse(JSON.stringify(fixture.chat.serialize()));
  const reopened = new ChatController({ hydrateFrom: snapshot });
  onTestFinished(() => reopened.dispose());
  const restored = reopened.messages.value.find((message): message is Extract<Message, { kind: 'tool' }> => message.kind === 'tool')!;
  expect(restored).toMatchObject({ toolPayloadRef: { threadId: 'fixture-thread', toolRunId: 'screenshot-call' } });
  expect(restored.output).toBeUndefined();
  expect(JSON.stringify(snapshot)).not.toContain(screenshot);
});
