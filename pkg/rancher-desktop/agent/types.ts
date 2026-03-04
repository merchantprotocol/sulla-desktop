// Agent System Types
// Flow: SensoryInput → ContextDetector → ConversationThread → Response
import { BaseThreadState } from './nodes/Graph';
import type { ChatMessage } from './languagemodels/BaseLanguageModel';

// ============================================================================
// SENSORY INPUT TYPES
// ============================================================================

export interface SensoryInput {
  id: string;
  type: 'text' | 'audio' | 'image';
  data: string;
  metadata: SensoryMetadata;
  timestamp: number;
}

export interface SensoryMetadata {
  source: 'keyboard' | 'microphone' | 'camera' | 'api' | 'calendar' | 'heartbeat';
  speaker?: string;
  language?: string;
  isBackgroundTask?: boolean;
  eventId?: number;
  eventTitle?: string;
  [key: string]: unknown;
}

// ============================================================================
// CONTEXT DETECTOR TYPES
// ============================================================================

export interface ThreadContext {
  threadId: string;
  isNew: boolean;
  summary: string;
  topic?: string;
  confidence: number;
  clearMessages?: boolean; // If true, caller should clear messages for fresh start
}

// ============================================================================
// CONVERSATION THREAD TYPES
// ============================================================================


// Backwards compatibility aliases
export type ThreadState = BaseThreadState;
export type Message = ChatMessage;

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolName: string;
  success: boolean;
  result?: unknown;
  error?: string;
  toolCallId?: string;
}

export interface PendingToolResult {
  toolCallId: string;
  toolName: string;
  success: boolean;
  result?: unknown;
  error?: string;
  content: string;
  nodeId: string;
  nodeName: string;
  timestamp: number;
  rawProviderContent?: any;
}

// ============================================================================
// RESPONSE TYPES
// ============================================================================

export interface AgentResponse {
  id: string;
  threadId: string;
  type: 'text' | 'audio';
  content: string;
  refined: boolean; // Whether critique step was applied
  metadata: Record<string, unknown>;
  timestamp: number;
}

// ============================================================================
// EVENT TYPES (for streaming/progress updates)
// ============================================================================

export interface AgentEvent {
  type: 'progress' | 'chunk' | 'complete' | 'error';
  threadId: string;
  data: unknown;
  timestamp: number;
}

export type AgentEventHandler = (event: AgentEvent) => void;
