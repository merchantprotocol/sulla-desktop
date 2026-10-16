import * as fs from 'node:fs';
import * as path from 'node:path';

import { getDesktopVaultClient } from '../agent/services/DesktopVaultClient';

const DEFAULT_SECRET_PATH = '/dev/shm/sulla-tools-secrets/agent-key.json';

/**
 * Provision the unlocked Desktop agent key into VM tmpfs for a container bind
 * mount. The launcher must mount the returned path at /run/secrets/sulla-agent-key
 * read-only and call remove() immediately after the container stops.
 */
export async function provisionAgentKeyForContainer(secretPath = DEFAULT_SECRET_PATH): Promise<{ path: string; remove: () => void }> {
  const resolved = path.resolve(secretPath);
  if (!(resolved.startsWith('/dev/shm/') || resolved.startsWith('/run/'))) {
    throw new Error('Agent keys may only be provisioned into a tmpfs path under /dev/shm or /run');
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  await getDesktopVaultClient().withAgentKeyPair(({ publicKey, privateKey }) => {
    const payload = Buffer.from(JSON.stringify({ publicKey, privateKey: privateKey.toString('base64url') }));
    try {
      fs.writeFileSync(resolved, payload, { mode: 0o400, flag: 'w' });
      fs.chmodSync(resolved, 0o400);
    } finally {
      payload.fill(0);
    }
    return Promise.resolve();
  });
  return {
    path:   resolved,
    remove: () => {
      try { fs.unlinkSync(resolved) } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
    },
  };
}
