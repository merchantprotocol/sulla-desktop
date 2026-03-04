/**
 * Shared local GGUF model options displayed in FirstRunResources and LanguageModelSettings.
 * Keys match the GGUF_MODELS registry in LlamaCppService.ts.
 *
 * Both pages import from here so changes propagate to both locations.
 */
export interface LocalModelOption {
  name: string;
  displayName: string;
  size: string;
  minMemoryGB: number;
  minCPUs: number;
  description: string;
}

export const LOCAL_MODELS: LocalModelOption[] = [
  {
    name: 'qwen3.5-0.8b',
    displayName: 'Qwen3.5 0.8B',
    size: '600MB',
    minMemoryGB: 1,
    minCPUs: 1,
    description: 'Qwen3.5 0.8B \u2014 fast and lightweight',
  },
  {
    name: 'qwen3.5-4b',
    displayName: 'Qwen3.5 4B',
    size: '2.7GB',
    minMemoryGB: 4,
    minCPUs: 2,
    description: 'Qwen3.5 4B \u2014 balanced performance and speed',
  },
  {
    name: 'qwen3.5-9b',
    displayName: 'Qwen3.5 9B',
    size: '5.6GB',
    minMemoryGB: 8,
    minCPUs: 4,
    description: 'Qwen3.5 9B \u2014 strongest reasoning, recommended',
  },
];
