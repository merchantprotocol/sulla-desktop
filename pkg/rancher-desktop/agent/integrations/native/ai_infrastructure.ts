import type { Integration } from '../types';

export const nativeAiInfrastructureIntegrations: Record<string, Integration> = {
  grok: {
    id: 'grok',
    sort: 2,
    paid: true,
    beta: false,
    comingSoon: false,
    name: 'Grok',
    description: 'Connect xAI Grok models for agent prompts and completions.',
    category: 'AI Infrastructure',
    icon: 'grok.svg',
    connected: false,
    version: '1.0.0',
    lastUpdated: '2026-02-28 11:42:00',
    developer: 'xAI',
    formGuide: 'Paste your xAI API key to enable Grok model access.',
    properties: [
      {
        key: 'api_key',
        title: 'xAI API Key',
        hint: 'Generate this in your xAI developer console.',
        type: 'password',
        required: true,
        placeholder: 'xai-...'
      },
      {
        key: 'model',
        title: 'Model',
        hint: 'Select a Grok model to use for completions.',
        type: 'select',
        required: true,
        placeholder: 'Select a model...',
        selectBoxId: 'grok_models',
        selectDependsOn: ['api_key']
      }
    ]
  },

  anthropic: {
    id: 'anthropic',
    sort: 3,
    paid: true,
    beta: false,
    comingSoon: false,
    name: 'Anthropic',
    description: 'Connect Anthropic Claude models for reasoning and assistant tasks.',
    category: 'AI Infrastructure',
    icon: 'anthropic.svg',
    connected: false,
    version: '1.0.0',
    lastUpdated: '2026-02-28 11:42:00',
    developer: 'Anthropic',
    formGuide: 'Paste your Anthropic API key to enable Claude model access.',
    properties: [
      {
        key: 'api_key',
        title: 'Anthropic API Key',
        hint: 'Generate this in your Anthropic Console.',
        type: 'password',
        required: true,
        placeholder: 'sk-ant-...'
      },
      {
        key: 'model',
        title: 'Model',
        hint: 'Select a Claude model to use for completions.',
        type: 'select',
        required: true,
        placeholder: 'Select a model...',
        selectBoxId: 'anthropic_models',
        selectDependsOn: ['api_key']
      }
    ]
  },

  openai: {
    id: 'openai',
    sort: 4,
    paid: true,
    beta: false,
    comingSoon: false,
    name: 'OpenAI',
    description: 'Connect OpenAI models for chat, reasoning, and multimodal generation.',
    category: 'AI Infrastructure',
    icon: 'openai.svg',
    connected: false,
    oauth: true,
    oauthProviderId: 'openai',
    version: '1.0.0',
    lastUpdated: '2026-02-28 11:42:00',
    developer: 'OpenAI',
    formGuide: 'Paste your OpenAI API key or sign in with OAuth for unlimited access via your ChatGPT Plus/Pro subscription.',
    properties: [
      {
        key: 'api_key',
        title: 'OpenAI API Key',
        hint: 'Generate this in your OpenAI dashboard.',
        type: 'password',
        required: true,
        placeholder: 'sk-...'
      },
      {
        key: 'model',
        title: 'Model',
        hint: 'Select an OpenAI model to use for completions.',
        type: 'select',
        required: true,
        placeholder: 'Select a model...',
        selectBoxId: 'openai_models',
        selectDependsOn: ['api_key']
      }
    ]
  },

  kimi: {
    id: 'kimi',
    sort: 5,
    paid: true,
    beta: false,
    comingSoon: false,
    name: 'Kimi',
    description: 'Connect Kimi models (Moonshot AI) for long-context generation tasks.',
    category: 'AI Infrastructure',
    icon: 'kimi.svg',
    connected: false,
    version: '1.0.0',
    lastUpdated: '2026-02-28 11:42:00',
    developer: 'Moonshot AI',
    formGuide: 'Paste your Kimi API key to enable Moonshot model access.',
    properties: [
      {
        key: 'api_key',
        title: 'Kimi API Key',
        hint: 'Generate this in your Moonshot/Kimi developer console.',
        type: 'password',
        required: true,
        placeholder: 'kimi-...'
      },
      {
        key: 'model',
        title: 'Model',
        hint: 'Select a Kimi/Moonshot model to use.',
        type: 'select',
        required: true,
        placeholder: 'Select a model...',
        selectBoxId: 'kimi_models',
        selectDependsOn: ['api_key']
      }
    ]
  },

  nvidia: {
    id: 'nvidia',
    sort: 6,
    paid: true,
    beta: false,
    comingSoon: false,
    name: 'NVIDIA',
    description: 'Connect NVIDIA NIM and hosted inference endpoints for AI workloads.',
    category: 'AI Infrastructure',
    icon: 'nvidia.svg',
    connected: false,
    version: '1.0.0',
    lastUpdated: '2026-02-28 11:42:00',
    developer: 'NVIDIA',
    formGuide: 'Paste your NVIDIA API key to enable NIM/inference endpoint access.',
    properties: [
      {
        key: 'api_key',
        title: 'NVIDIA API Key',
        hint: 'Generate this in NVIDIA Build / NGC account settings.',
        type: 'password',
        required: true,
        placeholder: 'nvapi-...'
      },
      {
        key: 'model',
        title: 'Model',
        hint: 'Select an NVIDIA model to use.',
        type: 'select',
        required: true,
        placeholder: 'Select a model...',
        selectBoxId: 'nvidia_models',
        selectDependsOn: ['api_key']
      }
    ]
  },

  ollama: {
    id: 'ollama',
    sort: 7,
    paid: false,
    beta: false,
    comingSoon: false,
    name: 'Ollama',
    description: 'Connect to a local or remote Ollama server for chat and embedding models.',
    category: 'AI Infrastructure',
    icon: 'ollama.svg',
    connected: false,
    version: '1.0.0',
    lastUpdated: '2026-02-28 12:45:00',
    developer: 'Ollama',
    formGuide: 'Set your Ollama base URL, then choose both a generation model and an embed-text model.',
    properties: [
      {
        key: 'base_url',
        title: 'Ollama Base URL',
        hint: 'URL to your Ollama server. Defaults to http://127.0.0.1:11434 if omitted by your runtime.',
        type: 'url',
        required: true,
        placeholder: 'http://127.0.0.1:11434'
      },
      {
        key: 'model',
        title: 'Model',
        hint: 'Select the Ollama model used for chat/completions.',
        type: 'select',
        required: true,
        placeholder: 'Select a model...',
        selectBoxId: 'ollama_models',
        selectDependsOn: ['base_url']
      },
      {
        key: 'embed_text_model',
        title: 'Embed Text Model',
        hint: 'Select the model used for text embeddings.',
        type: 'select',
        required: true,
        placeholder: 'Select an embedding model...',
        selectBoxId: 'ollama_embed_text_models',
        selectDependsOn: ['base_url']
      }
    ]
  },

  custom: {
    id: 'custom',
    sort: 8,
    paid: false,
    beta: false,
    comingSoon: false,
    name: 'Custom',
    description: 'Connect a custom AI provider endpoint using your own base URL.',
    category: 'AI Infrastructure',
    icon: 'custom.svg',
    connected: false,
    version: '1.0.0',
    lastUpdated: '2026-02-28 11:46:00',
    developer: 'Custom',
    formGuide: 'Enter the base URL for your custom AI provider endpoint.',
    properties: [
      {
        key: 'base_url',
        title: 'Base URL',
        hint: 'Required. Provide the API base URL for your custom AI provider.',
        type: 'url',
        required: true,
        placeholder: 'https://api.example.com/v1'
      },
      {
        key: 'model',
        title: 'Model',
        hint: 'Select a model from your custom endpoint (fetched from /models).',
        type: 'select',
        required: false,
        placeholder: 'Select a model...',
        selectBoxId: 'custom_models',
        selectDependsOn: ['base_url', 'api_key']
      }
    ]
  },

};
