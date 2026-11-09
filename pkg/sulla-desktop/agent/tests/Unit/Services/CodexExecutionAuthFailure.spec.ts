// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveCodexExecutionAuth } from '../../../languagemodels/codexExecutionAuth';
import { createGuestCodexBrokerLease } from '../../../languagemodels/codexGuestBrokerLease';
import { AuthExpired, Transient, VaultLocked } from '../../../languagemodels/failures';

vi.mock('@pkg/vault-broker', () => ({ usesContainerVaultAuthority: () => true }));
vi.mock('@pkg/main/firstRun/pendingCredentials', () => ({ getPendingCredential: () => undefined }));
vi.mock('../../../util/codexAuthFile', () => ({ ensureCodexAuthFile: vi.fn(), extractChatgptAccountId: vi.fn() }));
vi.mock('../../../languagemodels/codexGuestBrokerLease', () => ({ createGuestCodexBrokerLease: vi.fn() }));
vi.mock('../../../languagemodels/codexPendingMemoryBridge', () => ({ createCodexPendingMemoryBridge: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe('Codex execution authentication failures', () => {
  it('does not label a broker network failure as expired sign-in or locked vault', async () => {
    vi.mocked(createGuestCodexBrokerLease).mockRejectedValueOnce(new Error('network connection reset'));
    const error = await resolveCodexExecutionAuth({ conversationId: 'synthetic-thread' }).catch(error => error);
    expect(error).toBeInstanceOf(Transient);
    expect(error).not.toBeInstanceOf(AuthExpired);
    expect(error).not.toBeInstanceOf(VaultLocked);
  });
  it('preserves authoritative expiry and vault-lock failures without disguising them', async () => {
    for (const error of [new AuthExpired('codex'), new VaultLocked('codex')]) {
      vi.mocked(createGuestCodexBrokerLease).mockRejectedValueOnce(error);
      await expect(resolveCodexExecutionAuth({ conversationId: 'synthetic-thread' })).rejects.toBe(error);
    }
  });
});
