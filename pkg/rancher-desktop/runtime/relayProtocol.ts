export interface RelayToolResult {
  success: boolean;
  result?: unknown;
  error?: {
    code:     string;
    message:  string;
    details?: unknown;
  };
}

/** Serializable subset of the tool execution context carried over the relay. */
export interface RelayToolExecutionContext {
  v:                      1;
  iss:                    string;
  aud:                    'sulla-tools';
  sub:                    string;
  org_id?:                string;
  agent_id?:              string;
  pod_id?:                string;
  thread_id?:             string;
  job_id?:                string;
  workflow_execution_id?: string;
  device_id?:             string;
  scopes:                 string[];
  iat:                    number;
  exp:                    number;
  jti:                    string;
  request_id:             string;
}

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
