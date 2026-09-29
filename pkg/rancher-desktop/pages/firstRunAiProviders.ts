/**
 * AI providers offered in the first-run wizard. Sign-in only — no API keys.
 * Each one runs on the user's existing subscription through OAuth.
 */

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

export type FirstRunAiProviderId = 'claude-code' | 'codex' | 'grok';

export interface FirstRunAiProvider {
  id:   FirstRunAiProviderId;
  name: string;
  plan: string;
  icon: string;
}

export const FIRST_RUN_AI_PROVIDERS: FirstRunAiProvider[] = [
  {
    id: 'claude-code', name: 'Claude', plan: 'Claude Pro or Max', icon: 'anthropic.svg',
  },
  {
    id: 'codex', name: 'ChatGPT', plan: 'ChatGPT Plus or Pro', icon: 'openai.svg',
  },
  {
    id: 'grok', name: 'Grok', plan: 'SuperGrok or X Premium+', icon: 'grok.svg',
  },
];

// SullaSettingsModel key for the wizard's pick. Deliberately not
// `firstrun_remoteProvider`: FirstRunRemoteCredentialsSeeder reads that key
// and would mark a keyless 'default' account as the connected one, shadowing
// the OAuth account.
export const FIRST_RUN_AI_PROVIDER_KEY = 'firstrun_aiProvider';

export function getFirstRunAiProvider(id: string): FirstRunAiProvider | undefined {
  return FIRST_RUN_AI_PROVIDERS.find(p => p.id === id);
}

export function firstRunAiIconSrc(icon: string): string | null {
  try {
    return require(`@pkg/assets/images/${ icon }`);
  } catch {
    return null;
  }
}

/**
 * Run the provider's OAuth sign-in (opens the sign-in window from main), then
 * tell main to make it the primary model. Resolves with an error message on
 * failure, or null on success.
 */
export async function signInFirstRunAi(id: FirstRunAiProviderId): Promise<string | null> {
  try {
    if (id === 'claude-code') {
      // `claude setup-token` in the VM, driven over a PTY.
      const result = await ipcRenderer.invoke('claude-oauth:start');

      if (result?.error) return result.error;
      if (!result?.token) return 'Sign-in finished without a token. Try again.';
    } else {
      const result = await ipcRenderer.invoke('integration-oauth:start', {
        integrationId: id,
        providerId:    id,
        accountId:     'oauth',
      });

      if (!result?.success) return result?.error || 'Sign-in failed. Try again.';
    }
    await ipcRenderer.invoke('first-run-ai:connected', id);

    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
