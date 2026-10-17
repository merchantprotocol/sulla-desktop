/** Container-owned, idempotent legacy migration trigger. */
import { createHash } from 'node:crypto';

import { getDesktopVaultClient } from './DesktopVaultClient';

export function legacyAccountItemId(integrationId: string, accountId: string): string {
  const hex = createHash('sha256').update(`sulla-legacy-account-v2:${ integrationId }:${ accountId }`).digest('hex').slice(0, 32);
  return `${ hex.slice(0, 8) }-${ hex.slice(8, 12) }-5${ hex.slice(13, 16) }-8${ hex.slice(17, 20) }-${ hex.slice(20) }`;
}

/** Password is intentionally ignored; no human secret may cross Desktop IPC. */
export async function importLegacyCredentials(_masterPassword?: string): Promise<void> {
  await getDesktopVaultClient().migrate();
}
