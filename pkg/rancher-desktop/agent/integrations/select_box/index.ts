import { registerSelectBoxProvider } from './registry';
import { GrokModels } from './GrokModels';
import { AnthropicModels } from './AnthropicModels';
import { OpenAIModels } from './OpenAIModels';
import { KimiModels } from './KimiModels';
import { AlibabaModels } from './AlibabaModels';
import { NvidiaModels } from './NvidiaModels';
import { CustomModels } from './CustomModels';
import { OllamaModels, OllamaEmbedTextModels } from './OllamaModels';
import { ElevenLabsVoices } from './ElevenLabsVoices';

export { SelectBoxProvider, type SelectBoxContext, type SelectOption } from './SelectBoxProvider';
export { registerSelectBoxProvider, getSelectBoxProvider, getAllSelectBoxProviders } from './registry';

// Auto-register all providers on import
registerSelectBoxProvider(new GrokModels());
registerSelectBoxProvider(new AnthropicModels());
registerSelectBoxProvider(new OpenAIModels());
registerSelectBoxProvider(new KimiModels());
registerSelectBoxProvider(new AlibabaModels());
registerSelectBoxProvider(new NvidiaModels());
registerSelectBoxProvider(new CustomModels());
registerSelectBoxProvider(new OllamaModels());
registerSelectBoxProvider(new OllamaEmbedTextModels());
registerSelectBoxProvider(new ElevenLabsVoices());
