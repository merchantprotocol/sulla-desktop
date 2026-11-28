// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { RunActivityTracker } from '@pkg/agent/services/RunActivity';

describe('RunActivityTracker action counts', () => {
  it('counts discrete requests/tool boundaries once on the leaf task and retains a safe latest action', () => {
    // risk: inaccurate activity meters or leaking tool arguments into live labels
    let now = 1_000;
    const tracker = new RunActivityTracker(
      { acquire: () => undefined, release: () => undefined },
      { inFlight: () => undefined, clearKey: () => undefined },
      () => now,
    );
    const metadata = { activityKeys: ['parent#0', 'job#0'] };
    tracker.begin('job#0');
    for (let token = 0; token < 50; token++) {
      now++;
      tracker.touch(metadata);
    }
    tracker.touch({ ...metadata, phase: 'tool_result', toolRunId: 'liveness-only' });
    expect(tracker.actionCount('job#0')).toBe(0);

    tracker.recordActionForMetadata(metadata, 'request_start');
    tracker.recordActionForMetadata(metadata, 'tool_start', 'mcp__sulla-native__github_get_pr', 'call-1');
    tracker.recordActionForMetadata(metadata, 'tool_start', 'mcp__sulla-native__github_get_pr', 'call-1');
    tracker.recordActionForMetadata(metadata, 'tool_end', 'tool', 'call-1');
    tracker.recordActionForMetadata(metadata, 'tool_end', 'tool', 'call-1');

    expect(tracker.actionCount('job#0')).toBe(3);
    expect(tracker.actionCount('parent#0')).toBe(0);
    expect(tracker.lastActivityAt('job#0')).toBe(now);
    expect(tracker.lastAction('job#0')).toEqual({ kind: 'tool', label: 'sulla github/get_pr', at: new Date(now).toISOString() });
    expect(tracker.lastAction('parent#0')).toBeNull();
  });

  it('counts provider request and tool boundary events without counting stream payloads', () => {
    // risk: provider CLI stream events are omitted or output/thinking chunks inflate counts
    const tracker = new RunActivityTracker(
      { acquire: () => undefined, release: () => undefined },
      { inFlight: () => undefined, clearKey: () => undefined },
      () => 2_000,
    );
    const metadata = { activityKeys: ['parent#0', 'container#3'] };
    tracker.recordProviderStreamEvent(metadata, { type: 'stream_event', event: { type: 'message_start' } });
    tracker.recordProviderStreamEvent(metadata, { type: 'turn.started' });
    tracker.recordProviderStreamEvent(metadata, { type: 'item.started', item: { id: 'item-1', item_type: 'command_execution', command: 'git status --token SYNTHETIC' } });
    tracker.recordProviderStreamEvent(metadata, { type: 'item.completed', item: { id: 'item-1', item_type: 'command_execution', exit_code: 0 } });
    expect(tracker.actionCount('container#3')).toBe(4);
    expect(tracker.lastAction('container#3')?.label).toBe('shell');
    tracker.recordProviderStreamEvent(metadata, { type: 'item.started', item: { id: 'item-1', item_type: 'command_execution', command: 'git status' } });
    tracker.recordProviderStreamEvent(metadata, { type: 'item.completed', item: { id: 'item-1', item_type: 'command_execution', exit_code: 0 } });
    expect(tracker.actionCount('container#3')).toBe(4);
    tracker.recordProviderStreamEvent(metadata, { type: 'turn.started' });
    tracker.recordProviderStreamEvent(metadata, { type: 'item.started', item: { id: 'item-1', item_type: 'command_execution', command: 'git status' } });
    tracker.recordProviderStreamEvent(metadata, { type: 'item.completed', item: { id: 'item-1', item_type: 'command_execution', exit_code: 0 } });
    expect(tracker.actionCount('container#3')).toBe(7);
    tracker.recordProviderStreamEvent(metadata, { type: 'item.started', item: { id: 'item-2', item_type: 'mcp_tool_call', server: 'sulla-native', tool: 'github_get_pr', arguments: { number: 2988, token: 'SYNTHETIC' } } });
    tracker.recordProviderStreamEvent(metadata, { type: 'item.completed', item: { id: 'item-2', item_type: 'mcp_tool_call', server: 'sulla-native', tool: 'github_get_pr' } });
    expect(tracker.lastAction('container#3')?.label).toBe('sulla github/get_pr');
    expect(JSON.stringify(tracker.lastAction('container#3'))).not.toContain('SYNTHETIC');
    tracker.recordProviderStreamEvent(metadata, { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'claude-1', name: 'Bash', input: { command: 'pwd --token SYNTHETIC' } } } });
    tracker.recordProviderStreamEvent(metadata, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'claude-1' }] } });
    tracker.recordProviderStreamEvent(metadata, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'not an action' } } });

    expect(tracker.actionCount('container#3')).toBe(11);
    expect(tracker.actionCount('parent#0')).toBe(0);
    expect(tracker.lastAction('container#3')).toEqual({ kind: 'tool', label: 'bash', at: new Date(2_000).toISOString() });
    expect(JSON.stringify(tracker.lastAction('container#3'))).not.toContain('SYNTHETIC');
  });

});
