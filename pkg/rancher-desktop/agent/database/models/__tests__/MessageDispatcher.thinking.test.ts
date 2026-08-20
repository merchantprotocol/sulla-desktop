import { describe, expect, it, jest } from '@jest/globals';
import { ref } from 'vue';

import { createMessageDispatcher, type DispatchContext } from '../MessageDispatcher';

import type { WebSocketMessage } from '@pkg/agent/services/WebSocketClientService';
import type { ChatMessage } from '../../registry/AgentPersonaRegistry';

function makeContext(messages: ChatMessage[] = []): DispatchContext {
  return {
    messages,
    graphRunning:         ref(false),
    waitingForUser:       ref(false),
    stopReason:           ref(null),
    currentActivity:      ref('Thinking'),
    registry:             { setLoading: jest.fn() } as any,
    toolRunIdToMessageId: new Map(),
    speakListeners:       [],
    setThreadId:          jest.fn(),
    getThreadId:          () => 'thread-1',
    handleTokenInfo:      jest.fn(),
    removeAsset:          jest.fn(),
  };
}

function thinking(content: string): WebSocketMessage {
  return {
    type:      'assistant_message',
    data:      {
      role:      'assistant',
      kind:      'thinking',
      content,
      thread_id: 'thread-1',
    },
    timestamp: Date.now(),
  } as WebSocketMessage;
}

describe('MessageDispatcher thinking coalescing', () => {
  it('merges thinking across restored context user frames in the same run', () => {
    const messages: ChatMessage[] = [
      {
        id:        'user_1',
        channelId: 'sulla-desktop',
        threadId:  'thread-1',
        role:      'user',
        content:   'fix the thinking UI',
      },
      {
        id:        'thinking_1',
        channelId: 'sulla-desktop',
        threadId:  'thread-1',
        role:      'assistant',
        kind:      'thinking',
        content:   'Summarizing older conversation',
        _completed: true,
      } as ChatMessage,
      {
        id:        'restored_context_user',
        channelId: 'sulla-desktop',
        threadId:  'thread-1',
        role:      'user',
        content:   'Read recent conversation context...',
      },
    ];
    const ctx = makeContext(messages);

    createMessageDispatcher().dispatch(ctx, 'sulla-desktop', 'thread-1', thinking('Recalling who you are'));

    const thinkingMessages = ctx.messages.filter(m => m.kind === 'thinking');
    expect(thinkingMessages).toHaveLength(1);
    expect(thinkingMessages[0].content).toBe('Summarizing older conversation\n\nRecalling who you are');
    expect((thinkingMessages[0] as any)._completed).toBe(false);
  });

  it('starts a new thinking bubble after a real user turn boundary', () => {
    const messages: ChatMessage[] = [
      {
        id:        'user_1',
        channelId: 'sulla-desktop',
        threadId:  'thread-1',
        role:      'user',
        content:   'first request',
      },
      {
        id:        'thinking_1',
        channelId: 'sulla-desktop',
        threadId:  'thread-1',
        role:      'assistant',
        kind:      'thinking',
        content:   'Thinking about the first request',
        _completed: true,
      } as ChatMessage,
      {
        id:        'user_2',
        channelId: 'sulla-desktop',
        threadId:  'thread-1',
        role:      'user',
        content:   'second request',
      },
    ];
    const ctx = makeContext(messages);

    createMessageDispatcher().dispatch(ctx, 'sulla-desktop', 'thread-1', thinking('Thinking about the second request'));

    const thinkingMessages = ctx.messages.filter(m => m.kind === 'thinking');
    expect(thinkingMessages).toHaveLength(2);
    expect(thinkingMessages[1].content).toBe('Thinking about the second request');
  });
});
