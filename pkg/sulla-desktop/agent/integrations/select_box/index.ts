// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AlibabaModels } from './AlibabaModels';
import { alibabaPlans, alibabaRegions, kimiRegions } from './AIProviderOptions';
import { AnthropicModels } from './AnthropicModels';
import { ArceeModels } from './ArceeModels';
import { CohereModels } from './CohereModels';
import { CustomModels } from './CustomModels';
import { DeepSeekModels } from './DeepSeekModels';
import { ElevenLabsVoices } from './ElevenLabsVoices';
import { GrokModels } from './GrokModels';
import { KimiModels } from './KimiModels';
import { NvidiaModels } from './NvidiaModels';
import { OllamaModels } from './OllamaModels';
import { OpenAIModels } from './OpenAIModels';
import { VaultLlmAccess } from './VaultLlmAccess';
import { registerSelectBoxProvider } from './registry';

export { SelectBoxProvider, type SelectBoxContext, type SelectOption } from './SelectBoxProvider';
export { registerSelectBoxProvider, getSelectBoxProvider, getAllSelectBoxProviders } from './registry';

// Auto-register all providers on import
registerSelectBoxProvider(new GrokModels());
registerSelectBoxProvider(new AnthropicModels());
registerSelectBoxProvider(new OpenAIModels());
registerSelectBoxProvider(new KimiModels());
registerSelectBoxProvider(kimiRegions);
registerSelectBoxProvider(new AlibabaModels());
registerSelectBoxProvider(alibabaPlans);
registerSelectBoxProvider(alibabaRegions);
registerSelectBoxProvider(new NvidiaModels());
registerSelectBoxProvider(new ArceeModels());
registerSelectBoxProvider(new CohereModels());
registerSelectBoxProvider(new DeepSeekModels());
registerSelectBoxProvider(new CustomModels());
registerSelectBoxProvider(new OllamaModels());
registerSelectBoxProvider(new ElevenLabsVoices());
registerSelectBoxProvider(new VaultLlmAccess());
