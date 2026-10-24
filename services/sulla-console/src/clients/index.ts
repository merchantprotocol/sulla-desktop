// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

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
    accounts: new AccountsClient(config.accountsUrl),
    files: new UpstreamClient(config.filesUrl),
    vault: new UpstreamClient(config.vaultUrl),
    agents: new UpstreamClient(config.agentsUrl),
    workflows: new UpstreamClient(config.workflowsUrl),
  };
}
