// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import { issueLocalBrokerContext } from '../../../vault-broker';
import type { ToolExecutionContext } from '../../tools/executionContext';

/** Issues scoped local authority for Desktop-owned Slack system operations only. */
export class SlackSystemContextIssuer {
  issue(accountId: string): Promise<ToolExecutionContext> {
    return issueLocalBrokerContext({ agentId: 'slack-channel', podId: 'desktop-main', credentialScope: { integration_id: 'slack', account_id: accountId } });
  }
}
