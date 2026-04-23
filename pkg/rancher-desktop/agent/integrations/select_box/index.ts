import { AlibabaModels } from './AlibabaModels';
import { AnthropicModels } from './AnthropicModels';
import { CohereModels } from './CohereModels';
import { CustomModels } from './CustomModels';
import { ElevenLabsVoices } from './ElevenLabsVoices';
import { GrokModels } from './GrokModels';
import { KimiModels } from './KimiModels';
import { NvidiaModels } from './NvidiaModels';
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
registerSelectBoxProvider(new AlibabaModels());
registerSelectBoxProvider(new NvidiaModels());
registerSelectBoxProvider(new CohereModels());
registerSelectBoxProvider(new CustomModels());
registerSelectBoxProvider(new ElevenLabsVoices());
registerSelectBoxProvider(new VaultLlmAccess());
