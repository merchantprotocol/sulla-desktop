import fs from 'node:fs/promises';

import { Agent, fetch as undiciFetch } from 'undici';

import type { VaultBrokerFetch } from './index';

let dispatcher: Promise<Agent> | undefined;

async function getDispatcher(): Promise<Agent> {
  dispatcher ??= (async() => {
    const caFile = process.env.SULLA_VAULT_TLS_CA_FILE;
    if (!caFile) throw new Error('SULLA_VAULT_TLS_CA_FILE is required for the tools vault transport');
    const ca = await fs.readFile(caFile, 'utf8');
    return new Agent({ connect: { ca } });
  })();
  try {
    return await dispatcher;
  } catch (error) {
    dispatcher = undefined;
    throw error;
  }
}

/** Tools-container HTTPS transport using only the mounted public CA. */
export const toolsVaultFetch: VaultBrokerFetch = async(input, init) => {
  return undiciFetch(input, {
    ...init,
    dispatcher: await getDispatcher(),
  } as Parameters<typeof undiciFetch>[1]) as unknown as Response;
};
