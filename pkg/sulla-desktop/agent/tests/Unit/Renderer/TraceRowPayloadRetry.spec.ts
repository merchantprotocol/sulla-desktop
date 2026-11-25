// @vitest-environment jsdom
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: vi.fn() } }));

import { DetailedTraceProjection } from '@pkg/pages/chat/components/transcript/DetailedTraceProjection';
import TraceRow from '@pkg/pages/chat/components/transcript/TraceRow.vue';
import { TranscriptReporting } from '@pkg/pages/chat/components/transcript/toolGroups';
import { ToolPayloadRepository } from '@pkg/pages/chat/services/ToolPayloadRepository';
import type { Message } from '@pkg/pages/chat/models/Message';
import { asMessageId } from '@pkg/pages/chat/types/chat';

describe('Detailed tool payload retry', () => {
  it('keeps the full inline payload visible when lookup misses and retries the durable result', async() => {
    // risk: data loss — a missed durable lookup must not hide the arguments or result still held inline.
    const input = JSON.stringify({ path: '/workspace/report.txt', api_key: 'SYNTHETIC_INLINE_ARGUMENT' });
    const inlineResult = 'SYNTHETIC_INLINE_RESULT';
    const durableResult = 'SYNTHETIC_DURABLE_RESULT';
    const invoke = vi.fn()
      .mockResolvedValueOnce({ success: false, error: 'No matching conversation log row.' })
      .mockResolvedValueOnce({ success: true, data: { type: 'tool_call', toolCallId: 'run-retry', result: durableResult } });
    const repository = new ToolPayloadRepository({ invoke } as any);
    const messages = [
      { id: asMessageId('retry-user'), kind: 'user', createdAt: 1, text: 'inspect' },
      { id: asMessageId('retry-tool'), kind: 'tool', createdAt: 2, tool: 'MCP tool', recordedToolName: 'mcp__files__read', desc: 'Read file', status: 'ok', input,
        output: inlineResult, toolPayloadRef: { threadId: 'thread-retry', toolRunId: 'run-retry' }, providerTool: true },
      { id: asMessageId('retry-reply'), kind: 'sulla', createdAt: 3, text: 'done' },
    ] satisfies Message[];
    const [turn] = new DetailedTraceProjection(undefined, undefined, undefined, repository)
      .project(messages, new TranscriptReporting().entries(messages, 'info'));
    const [row] = turn.rows.filter(item => item.kind === 'tool');
    const wrapper = mount(TraceRow, { props: { row } });

    await wrapper.get('button.dtr-x').trigger('click');
    await flushPromises();

    expect(wrapper.get('[role="status"]').text()).toContain('could not be loaded');
    expect(wrapper.get('button.dtr-retry').exists()).toBe(true);
    expect(wrapper.get('pre.dtr-raw').text()).toContain('SYNTHETIC_INLINE_ARGUMENT');
    expect(wrapper.get('pre.dtr-raw').text()).toContain(inlineResult);

    await wrapper.get('button.dtr-retry').trigger('click');
    await flushPromises();

    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    expect(wrapper.get('pre.dtr-raw').text()).toContain('SYNTHETIC_INLINE_ARGUMENT');
    expect(wrapper.get('pre.dtr-raw').text()).toContain(durableResult);
    expect(wrapper.get('pre.dtr-raw').text()).not.toContain('[REDACTED]');
    expect(invoke).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });
});
