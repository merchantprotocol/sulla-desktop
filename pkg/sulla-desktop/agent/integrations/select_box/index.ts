// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AlibabaModels } from './AlibabaModels';
import { alibabaPlans, alibabaRegions, kimiRegions, minimaxRegions, zaiRegions } from './AIProviderOptions';
import { AnthropicModels } from './AnthropicModels';
import { ElevenLabsVoices } from './ElevenLabsVoices';
import { GrokModels } from './GrokModels';
import { KimiModels } from './KimiModels';
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
// Kimi and Alibaba keep their own region-aware pickers; the rest use live discovery.
registerSelectBoxProvider(new KimiModels());
registerSelectBoxProvider(kimiRegions);
registerSelectBoxProvider(new AlibabaModels());
registerSelectBoxProvider(alibabaPlans);
registerSelectBoxProvider(alibabaRegions);
registerSelectBoxProvider(zaiRegions);
registerSelectBoxProvider(minimaxRegions);
for (const [selectId, providerId] of [
  ['google_models', 'google'],
  ['groq_models', 'groq'],
  ['mistral_models', 'mistral'],
  ['cerebras_models', 'cerebras'],
  ['together_models', 'together'],
  ['nvidia_models', 'nvidia'],
  ['arcee_models', 'arcee'],
  ['cohere_models', 'cohere'],
  ['deepseek_models', 'deepseek'],
  ['custom_models', 'custom'],
  ['openrouter_models', 'openrouter'],
  ['fireworks_models', 'fireworks'],
  ['perplexity_models', 'perplexity'],
  ['zai_models', 'zai'],
  ['minimax_models', 'minimax'],
  ['huggingface_models', 'huggingface'],
  ['github-models_models', 'github-models'],
  ['deepinfra_models', 'deepinfra'],
  ['sambanova_models', 'sambanova'],
  ['ollama-cloud_models', 'ollama-cloud'],
] as const) {
  registerSelectBoxProvider(new OpenAICompatibleModels(selectId, providerId));
}
registerSelectBoxProvider(new OllamaModels());
registerSelectBoxProvider(new ElevenLabsVoices());
registerSelectBoxProvider(new VaultLlmAccess());
