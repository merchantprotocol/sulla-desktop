// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs/promises';

import { Agent, fetch as undiciFetch } from 'undici';

import type { VaultBrokerFetch } from './index';

/** Tools-container HTTPS transport using only the mounted public CA. */
export class ToolsVaultTransport {
  private dispatcher: Promise<Agent> | undefined;

  constructor(private readonly caFileEnv: () => string | undefined = () => process.env.SULLA_VAULT_TLS_CA_FILE) {}

  readonly fetch: VaultBrokerFetch = async(input, init) => {
    return undiciFetch(input, {
      ...init,
      dispatcher: await this.getDispatcher(),
    } as Parameters<typeof undiciFetch>[1]) as unknown as Response;
  };

  private getDispatcher(): Promise<Agent> {
    this.dispatcher ??= this.createDispatcher().catch((error) => {
      this.dispatcher = undefined;
      throw error;
    });

    return this.dispatcher;
  }

  private async createDispatcher(): Promise<Agent> {
    const caFile = this.caFileEnv();
    if (!caFile) throw new Error('SULLA_VAULT_TLS_CA_FILE is required for the tools vault transport');
    const ca = await fs.readFile(caFile, 'utf8');

    return new Agent({ connect: { ca } });
  }
}

/** Compatibility seam for the tools broker runtime; prefer constructing a `ToolsVaultTransport`. */
export const toolsVaultFetch: VaultBrokerFetch = new ToolsVaultTransport().fetch;
