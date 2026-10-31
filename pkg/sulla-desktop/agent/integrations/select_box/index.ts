// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AnthropicModels } from './AnthropicModels';
import { ElevenLabsVoices } from './ElevenLabsVoices';
import { GrokModels } from './GrokModels';
import { OllamaModels } from './OllamaModels';
import { OpenAICompatibleModels } from './OpenAICompatibleModels';
import { OpenAIModels } from './OpenAIModels';
import { VaultLlmAccess } from './VaultLlmAccess';
import { registerSelectBoxProvider } from './registry';

export { SelectBoxProvider, type SelectBoxContext, type SelectOption } from './SelectBoxProvider';
export { registerSelectBoxProvider, getSelectBoxProvider, getAllSelectBoxProviders } from './registry';

// Auto-register all providers on import
registerSelectBoxProvider(new GrokModels());
registerSelectBoxProvider(new AnthropicModels());
registerSelectBoxProvider(new OpenAIModels());
for (const [selectId, providerId] of [
  ['google_models', 'google'],
  ['groq_models', 'groq'],
  ['mistral_models', 'mistral'],
  ['cerebras_models', 'cerebras'],
  ['together_models', 'together'],
  ['kimi_models', 'kimi'],
  ['nvidia_models', 'nvidia'],
  ['alibaba_models', 'alibaba'],
  ['arcee_models', 'arcee'],
  ['cohere_models', 'cohere'],
  ['deepseek_models', 'deepseek'],
  ['custom_models', 'custom'],
] as const) {
  registerSelectBoxProvider(new OpenAICompatibleModels(selectId, providerId));
}
registerSelectBoxProvider(new OllamaModels());
registerSelectBoxProvider(new ElevenLabsVoices());
registerSelectBoxProvider(new VaultLlmAccess());
