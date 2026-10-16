import type { CapabilityTokenClaims } from '@pkg/runtime/capabilityToken';

/** Serializable identity carried with every catalog tool invocation. */
export interface ToolExecutionContext extends CapabilityTokenClaims {
  request_id: string;
}
