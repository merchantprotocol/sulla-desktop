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
  authHeader?: 'authorization' | 'api-key';
  keyRequired?: boolean;
  local?: boolean;
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
  { id: 'azure-openai', name: 'Azure OpenAI / AI Foundry', developer: 'Microsoft', baseUrl: '', modelsUrl: '/models', keyHelp: 'In Azure portal or Foundry, open your resource → Keys and Endpoint; paste its HTTPS endpoint, API key, and deployment name.', defaultModelFilter: chatModels, authHeader: 'api-key' },
  { id: 'aws-bedrock', name: 'AWS Bedrock', developer: 'Amazon Web Services', baseUrl: '', modelsUrl: '/models', keyHelp: 'In AWS Console, open Amazon Bedrock → API keys; choose the region where you enabled model access.', defaultModelFilter: chatModels, staticModels: ['global.anthropic.claude-sonnet-4-5-20250929-v1:0', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'us.meta.llama4-maverick-17b-instruct-v1:0', 'amazon.nova-pro-v1:0'], regionSelect: { id: 'bedrock_regions', label: 'Region', options: [{ value: 'us-east-1', label: 'US East (N. Virginia)' }, { value: 'us-west-2', label: 'US West (Oregon)' }, { value: 'eu-central-1', label: 'Europe (Frankfurt)' }, { value: 'eu-west-1', label: 'Europe (Ireland)' }, { value: 'ap-northeast-1', label: 'Asia Pacific (Tokyo)' }, { value: 'ap-southeast-2', label: 'Asia Pacific (Sydney)' }] } },
  { id: 'lm-studio', name: 'LM Studio', developer: 'LM Studio', baseUrl: '', modelsUrl: '/models', keyHelp: 'Start the Local Server in LM Studio, then use its OpenAI-compatible URL; no API key is needed.', defaultModelFilter: chatModels, keyRequired: false, local: true },
  { id: 'local-server', name: 'Local server (OpenAI-compatible)', developer: 'Local', baseUrl: '', modelsUrl: '/models', keyHelp: 'Start your local OpenAI-compatible server and enter its /v1 base URL; no API key is needed.', defaultModelFilter: chatModels, keyRequired: false, local: true },
] as const satisfies readonly OpenAICompatibleProviderDefinition[];

export type OpenAICompatibleProviderId = typeof OPENAI_COMPATIBLE_PROVIDERS[number]['id'];

export function openAICompatibleProvider(id: string): OpenAICompatibleProviderDefinition | undefined {
  return OPENAI_COMPATIBLE_PROVIDERS.find(provider => provider.id === id);
}

export function providerBaseUrl(provider: OpenAICompatibleProviderDefinition, values: Record<string, string>): string {
  if (provider.id === 'azure-openai') {
    const endpoint = new URL(values.resource_url);
    const host = endpoint.hostname.toLowerCase();
    if (endpoint.protocol !== 'https:' || !['.openai.azure.com', '.services.ai.azure.com', '.cognitiveservices.azure.com'].some(suffix => host.endsWith(suffix))) {
      throw new Error('Azure endpoint must use HTTPS on openai.azure.com, services.ai.azure.com, or cognitiveservices.azure.com');
    }
    return `${ endpoint.origin }/openai/v1`;
  }
  if (provider.id === 'aws-bedrock') return `https://bedrock-runtime.${ values.region || 'us-east-1' }.amazonaws.com/openai/v1`;
  if (provider.id === 'lm-studio' || provider.id === 'local-server') {
    const fallback = provider.id === 'lm-studio' ? 'http://host.sulla.internal:1234/v1' : 'http://host.sulla.internal:8000/v1';
    const endpoint = new URL(values.base_url || fallback);
    const host = endpoint.hostname.toLowerCase();
    const privateLan = /^10\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\./.test(host);
    if (endpoint.protocol !== 'http:' || !(['localhost', '127.0.0.1', '::1', 'host.sulla.internal'].includes(host) || privateLan)) {
      throw new Error(`${ provider.name } only allows HTTP connections to localhost, host.sulla.internal, or a private LAN address`);
    }
    return endpoint.toString().replace(/\/+$/, '');
  }
  if (typeof provider.baseUrl === 'string') return provider.baseUrl;
  return provider.baseUrl[values.region] || Object.values(provider.baseUrl)[0];
}
