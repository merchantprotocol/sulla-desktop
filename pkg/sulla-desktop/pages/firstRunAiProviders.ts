// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * AI providers offered in the first-run wizard. Sign-in only — no API keys.
 * Each one runs on the user's existing subscription through OAuth.
 */


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
