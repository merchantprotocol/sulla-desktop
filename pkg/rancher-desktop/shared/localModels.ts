/**
 * Shared local GGUF model options displayed in FirstRunResources and LanguageModelSettings.
 * Keys match the GGUF_MODELS registry in LlamaCppService.ts.
 *
 * Both pages import from here so changes propagate to both locations.
 */
export interface LocalModelOption {
  name:           string;
  displayName:    string;
  size:           string;
  sizeBytes:      number;
  minMemoryGB:    number;
  minCPUs:        number;
  description:    string;
  nativeCtx:      number;
  kvBytesPerToken: number;
}

export const LOCAL_MODELS: LocalModelOption[] = [
  {
    name:        'qwen3.5-0.8b',
    displayName: 'Qwen3.5 0.8B',
    size:        '600MB',
    sizeBytes:   600_000_000,
    minMemoryGB: 1,
    minCPUs:     1,
    description: 'Qwen3.5 0.8B \u2014 fast and lightweight',
    nativeCtx:   32768,
    kvBytesPerToken: 3072,
  },
  {
    name:        'qwen3.5-4b',
    displayName: 'Qwen3.5 4B',
    size:        '2.7GB',
    sizeBytes:   2_700_000_000,
    minMemoryGB: 4,
    minCPUs:     2,
    description: 'Qwen3.5 4B \u2014 balanced performance and speed',
    nativeCtx:   32768,
    kvBytesPerToken: 9216,
  },
  {
    name:        'qwen3.5-9b',
    displayName: 'Qwen3.5 9B',
    size:        '5.6GB',
    sizeBytes:   5_600_000_000,
    minMemoryGB: 8,
    minCPUs:     4,
    description: 'Qwen3.5 9B \u2014 strongest reasoning, recommended',
    nativeCtx:   32768,
    kvBytesPerToken: 15360,
  },
  {
    name:        'gemma4-e2b',
    displayName: 'Gemma 4 E2B',
    size:        '3.1GB',
    sizeBytes:   3_100_000_000,
    minMemoryGB: 4,
    minCPUs:     2,
    description: "Google's Gemma 4 E2B \u2014 multimodal (text+image+audio), ultralight",
    nativeCtx:   8192,
    kvBytesPerToken: 7680,
  },
  {
    name:        'gemma4-e4b',
    displayName: 'Gemma 4 E4B',
    size:        '5.0GB',
    sizeBytes:   5_000_000_000,
    minMemoryGB: 7,
    minCPUs:     2,
    description: "Google's Gemma 4 E4B \u2014 multimodal (text+image+audio), recommended for most laptops",
    nativeCtx:   8192,
    kvBytesPerToken: 11520,
  },
  {
    name:        'gemma4-26b',
    displayName: 'Gemma 4 26B-A4B',
    size:        '17GB',
    sizeBytes:   17_000_000_000,
    minMemoryGB: 20,
    minCPUs:     4,
    description: "Google's Gemma 4 26B MoE \u2014 only 3.8B params active, runs like a 4B at frontier quality",
    nativeCtx:   8192,
    kvBytesPerToken: 23040,
  },
  {
    name:        'glm-4.7-flash',
    displayName: 'GLM-4.7 Flash',
    size:        '18.3GB',
    sizeBytes:   18_300_000_000,
    minMemoryGB: 20,
    minCPUs:     4,
    description: "Z.AI's GLM-4.7 Flash \u2014 30B MoE (3B active), best-in-class SWE-Bench & GPQA, 200K context",
    nativeCtx:   131072,
    kvBytesPerToken: 23040,
  },
  {
    name:        'foundation-sec-8b-abliterated',
    displayName: 'Foundation-Sec 8B Abliterated',
    size:        '5.0GB',
    sizeBytes:   5_000_000_000,
    minMemoryGB: 8,
    minCPUs:     2,
    description: "Cisco's security-focused 8B \u2014 purpose-built for pentesting and vuln analysis, no refusals",
    nativeCtx:   131072,
    kvBytesPerToken: 15360,
  },
  {
    name:        'qwen3-8b-abliterated',
    displayName: 'Qwen3 8B Abliterated',
    size:        '5.0GB',
    sizeBytes:   5_000_000_000,
    minMemoryGB: 8,
    minCPUs:     2,
    description: 'Qwen3 8B abliterated \u2014 strong at code and reasoning, no refusals',
    nativeCtx:   32768,
    kvBytesPerToken: 15360,
  },
  {
    name:        'dolphin3-8b',
    displayName: 'Dolphin 3.0 8B',
    size:        '4.9GB',
    sizeBytes:   4_900_000_000,
    minMemoryGB: 8,
    minCPUs:     2,
    description: "Eric Hartford's Dolphin 3.0 \u2014 uncensored Llama 3.1 8B, the OG unrestricted model",
    nativeCtx:   131072,
    kvBytesPerToken: 15360,
  },
];
