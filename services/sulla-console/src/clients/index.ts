// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License 1.0. See LICENSES/Sulla-Fair-Code-1.0.txt.

import type { ConsoleConfig } from '../config.js';
import { AccountsClient } from './accounts.js';
import { UpstreamClient } from './upstream.js';

export interface UpstreamClients {
  accounts: AccountsClient;
  files: UpstreamClient;
  vault: UpstreamClient;
  agents: UpstreamClient;
  workflows: UpstreamClient;
}

export function createUpstreamClients(config: ConsoleConfig): UpstreamClients {
  return {
    accounts: new AccountsClient(config.accountsUrl, config.accountsAdminSecret),
    files: new UpstreamClient(config.filesUrl),
    vault: new UpstreamClient(config.vaultUrl),
    agents: new UpstreamClient(config.agentsUrl),
    workflows: new UpstreamClient(config.workflowsUrl),
  };
}
