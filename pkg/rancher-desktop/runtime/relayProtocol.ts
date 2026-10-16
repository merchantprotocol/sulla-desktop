import type { ToolExecutionContext } from '@pkg/agent/tools/executionContext';

import type { ToolResult } from './desktopExecutor';

export type RelayToolResult = ToolResult;

/** Serializable execution context carried over the relay. */
export type RelayToolExecutionContext = ToolExecutionContext;

export interface RelayError {
  code:       'DEVICE_OFFLINE' | 'DEADLINE_EXCEEDED' | 'BACKPRESSURE' | 'FORBIDDEN' | 'BAD_REQUEST' | 'INTERNAL';
  message:    string;
  retryable?: boolean;
}

interface RelayEnvelopeBase {
  requestId: string;
  deviceId:  string;
}

export interface RelayToolCallEnvelope extends RelayEnvelopeBase {
  type:             'tool-call';
  action?:          'execute' | 'cancel';
  originReplicaId?: string;
  ctx?:             RelayToolExecutionContext;
  category?:        string;
  tool?:            string;
  args?:            unknown;
  deadlineAt?:      number;
}

export interface RelayToolResultEnvelope extends RelayEnvelopeBase {
  type:             'tool-result';
  originReplicaId?: string;
  result?:          RelayToolResult;
  error?:           RelayError;
}

/** Reserved for pod output and other incremental payloads. The relay does not emit it yet. */
export interface RelayStreamEnvelope extends RelayEnvelopeBase {
  type:    'stream';
  channel: string;
  data:    unknown;
}

export type RelayEnvelope = RelayToolCallEnvelope | RelayToolResultEnvelope | RelayStreamEnvelope;
