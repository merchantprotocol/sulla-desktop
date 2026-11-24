// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { PersonaAdapter } from './PersonaAdapter';
import { createMessageDispatcher } from '@pkg/agent/database/models/MessageDispatcher';
import { DetailedTraceProjection } from '../components/transcript/DetailedTraceProjection';
import { TranscriptReporting } from '../components/transcript/toolGroups';

// Electron's npm entry throws "failed to install correctly" outside Electron; PersonaAdapter's import chain reaches it.
vi.mock('electron', () => {
  const ipcRenderer = { invoke: vi.fn(), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
  return { ipcRenderer, default: { ipcRenderer } };
});

describe('PersonaAdapter', () => {
  it('preserves baseline Standard tool-card values while redacting Detailed payloads and legacy fallbacks', () => {
    // risk: Standard compatibility/privacy — shared transcript fields keep baseline values while Detailed-only payloads redact credentials.
    const command = 'echo "$HOME/$1" && echo "$tokenCount" # apiToken=fixture-shell-secret';
    const description = 'Prose references tokenCount=32 and apiToken=fixture-description-secret.';
    const error = 'Shell failed with accessToken=fixture-error-secret; tokenCount=32.';
    const result = {
      details: 'Result prose references tokenCount=32 and apiToken=fixture-result-secret.',
      tokenCount: 32,
    };
    const dispatcher = createMessageDispatcher();
    const context = {
      messages: [],
      toolRunIdToMessageId: new Map(),
      currentActivity: { value: '' },
    } as any;

    dispatcher.dispatch(context, 'agent-1', 'thread-1', {
      type: 'progress',
      data: { phase: 'tool_call', toolRunId: 'run-1', toolName: 'exec', args: { command, description } },
    } as any);
    dispatcher.dispatch(context, 'agent-1', 'thread-1', {
      type: 'progress',
      data: { phase: 'tool_result', toolRunId: 'run-1', success: false, error, result },
    } as any);

    const backendMessage = context.messages[0];
    expect(backendMessage.toolCard).toMatchObject({
      args: { command, description },
      description,
      summary: command,
      input: command,
      result,
      error,
    });
    expect(backendMessage.toolCard.output).toBeUndefined();

    const tracePayloads = new Map<string, unknown>();
    const adapter = Object.create(PersonaAdapter.prototype) as any;
    adapter.firstSeenAt = new Map();
    adapter.controller = {
      setDetailedTracePayload: (id: string, payload: unknown) => tracePayloads.set(id, payload),
    };
    const standardMessage = adapter.mapBackendMessage(backendMessage);

    expect(standardMessage).toMatchObject({
      kind: 'tool',
      desc: command,
      input: command,
      output: JSON.stringify(result, null, 2),
      error,
    });
    expect(standardMessage.output).toContain('fixture-result-secret');
    expect(JSON.stringify(tracePayloads.get(String(standardMessage.id)))).not.toMatch(/fixture-(?:shell|description|result)-secret/);

    const reporting = new TranscriptReporting();
    const legacyTrace = new DetailedTraceProjection().project(
      [standardMessage], reporting.entries([standardMessage], 'debug'), [], undefined, new Map(),
    );
    const traceRow = legacyTrace[0].rows[0];
    const serializedTraceRow = JSON.stringify(traceRow);
    expect(serializedTraceRow).not.toMatch(/fixture-(?:shell|description|result|error)-secret/);
    expect(serializedTraceRow).toContain('$HOME/$1');
    expect(serializedTraceRow).toContain('$tokenCount');
    expect(serializedTraceRow).toContain('tokenCount=32');
    expect(serializedTraceRow).toContain('[REDACTED]');
  });

  it('replaces matching optimistic bubbles in FIFO order before backend sync appends them', () => {
    // risk: data accuracy — sync order must not leave a duplicate user bubble.
    const adapter = Object.create(PersonaAdapter.prototype) as any;
    const transcript = [
      { id: 'optimistic-1', kind: 'user', text: 'same' },
      { id: 'optimistic-2', kind: 'user', text: 'same' },
    ];
    const backendMessages = [
      { id: 'backend-1', role: 'user', kind: 'text', content: '[voice] same' },
      { id: 'backend-2', role: 'user', kind: 'text', content: 'same' },
    ];
    adapter.ci = { messages: { value: backendMessages } };
    adapter.controller = {
      thread: { value: { messages: transcript } },
      updateMessage: (id: string, patch: object, index: number) => { transcript[index] = { ...transcript[index], ...patch }; },
      removeMessage: () => {},
    };
    adapter.optimisticUserMessages = new Map([['same', ['optimistic-1', 'optimistic-2']]]);
    adapter.seen = new Set();
    adapter.mapBackendMessage = (message: any) => ({ id: message.id, kind: 'user', text: message.content });

    adapter.reconcileOptimisticUserMessages();

    expect(transcript).toHaveLength(2);
    expect(transcript.map((message: any) => message.id)).toEqual(['backend-1', 'backend-2']);
    expect(adapter.seen).toEqual(new Set(['backend-1', 'backend-2']));
    expect(adapter.optimisticUserMessages.size).toBe(0);
  });

  it('does not mistake assistant history for this send’s first token', () => {
    // risk: telemetry accuracy — first-token latency must start after the send.
    const adapter = Object.create(PersonaAdapter.prototype) as any;
    const history = [{ id: 'old', role: 'assistant', kind: 'text', content: 'earlier answer' }];
    expect(adapter.hasNewAssistantText(history, history.length)).toBe(false);
    expect(adapter.hasNewAssistantText([...history, { id: 'new', role: 'assistant', kind: 'streaming', content: 'new token' }], history.length)).toBe(true);
  });

  it('applies support-session activation to subsequent chat sends without remounting', () => {
    // risk: permissions — activating the session live must bind the allowlisted remote tools before the next send.
    const adapter = Object.create(PersonaAdapter.prototype) as any;
    adapter.supportOptions = { tabId: 'support-tab' };
    expect(adapter.supportSessionMetadata()).toEqual({});
    adapter.setSupportSessionContext('session_12345678', ['support.logs.tail']);
    expect(adapter.supportSessionMetadata()).toMatchObject({ supportSessionId: 'session_12345678', allowedToolNames: ['support.logs.tail'] });
    adapter.setSupportSessionContext(undefined, []);
    expect(adapter.supportSessionMetadata()).toEqual({});
  });

  it('removes the optimistic bubble and shows the no-AI notice when disconnected', () => {
    // risk: availability — a failed connection must not leave a false delivered bubble.
    const adapter = Object.create(PersonaAdapter.prototype) as any;
    const messages: any[] = [{ id: 'optimistic', kind: 'user', text: 'hello' }];
    adapter.controller = {
      removeMessage: (id: string) => { const index = messages.findIndex(message => message.id === id); if (index >= 0) messages.splice(index, 1); },
      transitionRun: () => {},
      appendMessage: (message: object) => messages.push(message),
      persistThread: () => {},
    };
    adapter.optimisticUserMessages = new Map([['hello', ['optimistic']]]);

    adapter.showDisconnectedFeedback('optimistic', 'hello', 'hello', []);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ kind: 'user', text: 'hello' });
    expect(messages[1]).toMatchObject({ kind: 'notice', action: { kind: 'connect' } });
    expect(adapter.optimisticUserMessages.size).toBe(0);
  });
});
