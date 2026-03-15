/**
 * Shared local GGUF model options displayed in FirstRunResources and LanguageModelSettings.
 * Keys match the GGUF_MODELS registry in LlamaCppService.ts.
 *
 * Both pages import from here so changes propagate to both locations.
 */
export interface LocalModelOption {
  name:        string;
  displayName: string;
  size:        string;
  minMemoryGB: number;
  minCPUs:     number;
  description: string;
}

export const LOCAL_MODELS: LocalModelOption[] = [
  {
    name:        'qwen3.5-0.8b',
    displayName: 'Qwen3.5 0.8B',
    size:        '600MB',
    minMemoryGB: 1,
    minCPUs:     1,
    description: 'Qwen3.5 0.8B \u2014 fast and lightweight',
  },
  {
    name:        'qwen3.5-4b',
    displayName: 'Qwen3.5 4B',
    size:        '2.7GB',
    minMemoryGB: 4,
    minCPUs:     2,
    description: 'Qwen3.5 4B \u2014 balanced performance and speed',
  },
  {
    name:        'qwen3.5-9b',
    displayName: 'Qwen3.5 9B',
    size:        '5.6GB',
    minMemoryGB: 8,
    minCPUs:     4,
    description: 'Qwen3.5 9B \u2014 strongest reasoning, recommended',
  },
  {
    name:        'qwq-32b-abliterated-q2',
    displayName: 'QwQ 32B Abliterated (Q2_K)',
    size:        '13GB',
    minMemoryGB: 15,
    minCPUs:     4,
    description: 'QwQ 32B uncensored reasoning \u2014 smallest quantization, fits 32GB RAM',
  },
  {
    name:        'qwq-32b-abliterated-q3',
    displayName: 'QwQ 32B Abliterated (Q3_K_M)',
    size:        '16GB',
    minMemoryGB: 18,
    minCPUs:     4,
    description: 'QwQ 32B uncensored reasoning \u2014 balanced quality/size, recommended for 32GB',
  },
  {
    name:        'qwq-32b-abliterated-q4',
    displayName: 'QwQ 32B Abliterated (Q4_K_M)',
    size:        '20GB',
    minMemoryGB: 22,
    minCPUs:     4,
    description: 'QwQ 32B uncensored reasoning \u2014 best quality, needs 32GB+ RAM',
  },
];
