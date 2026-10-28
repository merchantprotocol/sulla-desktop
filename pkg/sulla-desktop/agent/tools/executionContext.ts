// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { CapabilityTokenClaims } from '@pkg/runtime/capabilityToken';

/** Serializable identity carried with every catalog tool invocation. */
export interface ToolExecutionContext extends CapabilityTokenClaims {
  request_id:        string;
  /** Exact signed credential authority propagated from the verified token. */
  credential_scope?: {
    integration_id?: string;
    account_id?:     string;
    item_id?:        string;
    repository?:    string;
  };
}
