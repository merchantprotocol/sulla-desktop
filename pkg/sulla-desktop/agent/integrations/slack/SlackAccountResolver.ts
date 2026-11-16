// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import type { IntegrationService } from '../../services/IntegrationService';
export class SlackAccountResolver {
  constructor(private readonly integrations: Pick<IntegrationService, 'getActiveAccountId' | 'getAccounts'>) {}
  async resolve(account?: string): Promise<string> {
    if (!account) return this.integrations.getActiveAccountId('slack');
    const accounts = await this.integrations.getAccounts('slack');
    const match = accounts.find(candidate => candidate.account_id === account);
    if (!match || match.credentialRequired === false) throw new Error(`Unknown Slack account: ${account}`);
    return account;
  }
}
