/**
 * AI providers offered in the first-run wizard. Sign-in only — no API keys.
 * Each one runs on the user's existing subscription through OAuth.
 */

import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { ref } from 'vue';

export type FirstRunAiProviderId = 'claude-code' | 'codex' | 'grok';
export type FirstRunAiSignInState = 'idle' | 'waiting' | 'signing-in' | 'done' | 'failed';

// Module-scoped refs survive wizard step changes, so the Finishing screen can
// observe an OAuth attempt started on Your AI without launching it again.
export const firstRunSelectedAiProvider = ref<FirstRunAiProviderId | ''>('');
export const firstRunAiSignInState = ref<FirstRunAiSignInState>('idle');
export const firstRunAiSignInError = ref('');
let signInAttempt: Promise<string | null> | null = null;

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
  firstRunSelectedAiProvider.value = id;
  if (signInAttempt) return signInAttempt;

  firstRunAiSignInState.value = id === 'claude-code' ? 'waiting' : 'signing-in';
  firstRunAiSignInError.value = '';

  const onClaudeUrl = () => {
    firstRunAiSignInState.value = 'signing-in';
  };

  if (id === 'claude-code') ipcRenderer.on('claude-oauth:url', onClaudeUrl);

  signInAttempt = (async() => {
    try {
      if (id === 'claude-code') {
        // Claude has no direct OAuth provider implementation. Its supported
        // path is `claude setup-token` inside Lima, so main waits for the VM +
        // CLI and opens the auth window automatically when both are available.
        const result = await ipcRenderer.invoke('claude-oauth:start', { waitForReady: true });

        if (result?.error) throw new Error(result.error);
        if (!result?.token) throw new Error('Sign-in finished without a token. Try again.');
      } else {
        const result = await ipcRenderer.invoke('integration-oauth:start', {
          integrationId:     id,
          providerId:        id,
          accountId:         'oauth',
          deferPersistence:  true,
        });

        if (!result?.success) throw new Error(result?.error || 'Sign-in failed. Try again.');
      }

      // Main acknowledges immediately, then waits in the background for the
      // token row before selecting the provider and closing first run.
      await ipcRenderer.invoke('first-run-ai:connected', id);
      firstRunAiSignInState.value = 'done';

      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      firstRunAiSignInError.value = message;
      firstRunAiSignInState.value = 'failed';

      return message;
    } finally {
      if (id === 'claude-code') ipcRenderer.removeListener('claude-oauth:url', onClaudeUrl);
      signInAttempt = null;
    }
  })();

  return signInAttempt;
}
