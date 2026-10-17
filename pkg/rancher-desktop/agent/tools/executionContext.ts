import type { CapabilityTokenClaims } from '@pkg/runtime/capabilityToken';

/** Serializable identity carried with every catalog tool invocation. */
export interface ToolExecutionContext extends CapabilityTokenClaims {
  request_id:        string;
  /** Exact signed credential authority propagated from the verified token. */
  credential_scope?: {
    integration_id: string;
    account_id:     string;
    repository?:    string;
  };
}
