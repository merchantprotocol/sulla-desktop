/**
 * Message component registry — maps a ChatMessage to the component that
 * renders it. Adding a new message kind means adding a component file
 * and one entry here; the chat page template never changes.
 */

import AssistantTextMessage from './AssistantTextMessage.vue';
import HtmlMessage from './HtmlMessage.vue';
import StreamingMessage from './StreamingMessage.vue';
import SubAgentMessage from './SubAgentMessage.vue';
import ThinkingMessage from './ThinkingMessage.vue';
import ToolMessage from './ToolMessage.vue';
import UserMessage from './UserMessage.vue';
import VoiceInterimMessage from './VoiceInterimMessage.vue';

import type { ChatMessage } from '@pkg/pages/agent/ChatInterface';
import type { Component } from 'vue';

const byKind: Record<string, Component> = {
  voice_interim:      VoiceInterimMessage,
  tool:               ToolMessage,
  sub_agent_activity: SubAgentMessage,
  thinking:           ThinkingMessage,
  streaming:          StreamingMessage,
  html:               HtmlMessage,
};

/**
 * Mirrors the precedence of the previous inline v-if chain: interim voice
 * bubbles win over the user-role check; kinds that arrive without their
 * payload fall back to plain text rendering.
 */
export function componentForMessage(m: ChatMessage): Component {
  if (m.kind === 'voice_interim') return VoiceInterimMessage;
  if (m.role === 'user') return UserMessage;
  if (m.kind === 'tool' && !m.toolCard) return AssistantTextMessage;
  if (m.kind === 'sub_agent_activity' && !m.subAgentActivity) return AssistantTextMessage;

  return (m.kind && byKind[m.kind]) || AssistantTextMessage;
}
