// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface OpenAICompatibleProviderDefinition {
  id: string;
  name: string;
  developer: string;
  baseUrl: string | Readonly<Record<string, string>>;
  modelsUrl: string;
  keyHelp: string;
  defaultModelFilter: RegExp;
  extraHeaders?: Readonly<Record<string, string>>;
  staticModels?: readonly string[];
  regionSelect?: { readonly id: string; readonly label: string; readonly options: readonly { readonly value: string; readonly label: string }[] };
}

const chatModels = /^(?!.*(?:embed|rerank|moderation|guard|image|audio|speech|tts|whisper))/i;

export const OPENAI_COMPATIBLE_PROVIDERS = [
  { id: 'openrouter', name: 'OpenRouter', developer: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', modelsUrl: 'https://openrouter.ai/api/v1/models', keyHelp: 'Get your key at openrouter.ai/keys.', defaultModelFilter: chatModels, extraHeaders: { 'HTTP-Referer': 'https://sulladesktop.com', 'X-Title': 'Sulla' } },
  { id: 'fireworks', name: 'Fireworks AI', developer: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1', modelsUrl: 'https://api.fireworks.ai/inference/v1/models', keyHelp: 'Find your key at app.fireworks.ai → Settings → API Keys.', defaultModelFilter: chatModels },
  { id: 'perplexity', name: 'Perplexity', developer: 'Perplexity AI', baseUrl: 'https://api.perplexity.ai', modelsUrl: '', keyHelp: 'Find your key at console.perplexity.ai → API Keys.', defaultModelFilter: chatModels, staticModels: ['sonar', 'sonar-pro', 'sonar-reasoning-pro', 'sonar-deep-research'] },
  { id: 'zai', name: 'Z.ai (GLM)', developer: 'Z.ai', baseUrl: { international: 'https://api.z.ai/api/paas/v4', china: 'https://open.bigmodel.cn/api/paas/v4', coding: 'https://api.z.ai/api/coding/paas/v4' }, modelsUrl: '/models', keyHelp: 'Get your key at z.ai → API Keys. China accounts use open.bigmodel.cn.', defaultModelFilter: chatModels, regionSelect: { id: 'zai_regions', label: 'Region / plan', options: [{ value: 'international', label: 'International' }, { value: 'china', label: 'China' }, { value: 'coding', label: 'GLM Coding Plan' }] } },
  { id: 'minimax', name: 'MiniMax', developer: 'MiniMax', baseUrl: { international: 'https://api.minimax.io/v1', china: 'https://api.minimaxi.com/v1' }, modelsUrl: '/models', keyHelp: 'Find your key at platform.minimax.io → API Keys.', defaultModelFilter: chatModels, regionSelect: { id: 'minimax_regions', label: 'Region', options: [{ value: 'international', label: 'International' }, { value: 'china', label: 'China' }] } },
  { id: 'huggingface', name: 'Hugging Face Inference Providers', developer: 'Hugging Face', baseUrl: 'https://router.huggingface.co/v1', modelsUrl: 'https://router.huggingface.co/v1/models', keyHelp: 'Create a token at huggingface.co/settings/tokens with “Make calls to Inference Providers” permission.', defaultModelFilter: chatModels },
  { id: 'github-models', name: 'GitHub Models', developer: 'GitHub', baseUrl: 'https://models.github.ai/inference', modelsUrl: 'https://models.github.ai/catalog/models', keyHelp: 'Create a fine-grained token at github.com/settings/tokens with Models (read) permission.', defaultModelFilter: chatModels, extraHeaders: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, staticModels: ['openai/gpt-4.1', 'openai/gpt-4.1-mini', 'meta/llama-4-scout-17b-16e-instruct'] },
  { id: 'deepinfra', name: 'DeepInfra', developer: 'DeepInfra', baseUrl: 'https://api.deepinfra.com/v1/openai', modelsUrl: 'https://api.deepinfra.com/v1/openai/models', keyHelp: 'Create an API key in your DeepInfra dashboard under API Keys.', defaultModelFilter: chatModels },
  { id: 'sambanova', name: 'SambaNova Cloud', developer: 'SambaNova', baseUrl: 'https://api.sambanova.ai/v1', modelsUrl: 'https://api.sambanova.ai/v1/models', keyHelp: 'Create an API key in SambaNova Cloud under API Keys.', defaultModelFilter: chatModels },
  { id: 'ollama-cloud', name: 'Ollama Cloud', developer: 'Ollama', baseUrl: 'https://ollama.com/v1', modelsUrl: 'https://ollama.com/api/tags', keyHelp: 'Create an API key in your Ollama account settings at ollama.com.', defaultModelFilter: chatModels },
] as const satisfies readonly OpenAICompatibleProviderDefinition[];

export type OpenAICompatibleProviderId = typeof OPENAI_COMPATIBLE_PROVIDERS[number]['id'];

export function openAICompatibleProvider(id: string): OpenAICompatibleProviderDefinition | undefined {
  return OPENAI_COMPATIBLE_PROVIDERS.find(provider => provider.id === id);
}

export function providerBaseUrl(provider: OpenAICompatibleProviderDefinition, values: Record<string, string>): string {
  if (typeof provider.baseUrl === 'string') return provider.baseUrl;
  return provider.baseUrl[values.region] || Object.values(provider.baseUrl)[0];
}
