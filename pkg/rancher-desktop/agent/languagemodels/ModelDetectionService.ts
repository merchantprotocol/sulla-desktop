/**
 * Detects model type and determines the correct API endpoint.
 * Handles reasoning models, chat models, code models, and completion models.
 */

export type ModelType = 'reasoning' | 'chat' | 'code' | 'completion' | 'unknown';
export type EndpointType = 'chat-completions' | 'responses' | 'completions';

export interface ModelEndpointConfig {
  type: ModelType;
  endpointType: EndpointType;
  endpoint: string;
  supportsStreaming: boolean;
  supportsToolCalls: boolean;
  requestTransform?: 'responses';
}

export class ModelDetectionService {
  private static readonly modelConfigs: Record<string, ModelEndpointConfig> = {
    // Reasoning models — use /v1/responses endpoint with special request format
    'gpt-5.5-pro': {
      type: 'reasoning',
      endpointType: 'responses',
      endpoint: '/responses',
      supportsStreaming: false,
      supportsToolCalls: true,
      requestTransform: 'responses',
    },
    'gpt-5.5': {
      type: 'reasoning',
      endpointType: 'responses',
      endpoint: '/responses',
      supportsStreaming: false,
      supportsToolCalls: true,
      requestTransform: 'responses',
    },
    'o3': {
      type: 'reasoning',
      endpointType: 'responses',
      endpoint: '/responses',
      supportsStreaming: false,
      supportsToolCalls: true,
      requestTransform: 'responses',
    },
    'o3-mini': {
      type: 'reasoning',
      endpointType: 'responses',
      endpoint: '/responses',
      supportsStreaming: false,
      supportsToolCalls: true,
      requestTransform: 'responses',
    },
    'o1': {
      type: 'reasoning',
      endpointType: 'responses',
      endpoint: '/responses',
      supportsStreaming: false,
      supportsToolCalls: true,
      requestTransform: 'responses',
    },
    'o1-mini': {
      type: 'reasoning',
      endpointType: 'responses',
      endpoint: '/responses',
      supportsStreaming: false,
      supportsToolCalls: true,
      requestTransform: 'responses',
    },

    // Code models — use /v1/responses endpoint (confirmed by testing)
    'gpt-5-codex': {
      type: 'code',
      endpointType: 'responses',
      endpoint: '/responses',
      supportsStreaming: false,
      supportsToolCalls: true,
      requestTransform: 'responses',
    },
    'gpt-5.3-codex': {
      type: 'code',
      endpointType: 'completions',
      endpoint: '/completions',
      supportsStreaming: true,
      supportsToolCalls: false,
    },

    // Standard chat models — use /chat/completions
    'gpt-5.4': {
      type: 'chat',
      endpointType: 'chat-completions',
      endpoint: '/chat/completions',
      supportsStreaming: true,
      supportsToolCalls: true,
    },
    'gpt-5.4-turbo': {
      type: 'chat',
      endpointType: 'chat-completions',
      endpoint: '/chat/completions',
      supportsStreaming: true,
      supportsToolCalls: true,
    },
    'gpt-5': {
      type: 'chat',
      endpointType: 'chat-completions',
      endpoint: '/chat/completions',
      supportsStreaming: true,
      supportsToolCalls: true,
    },
    'gpt-4o': {
      type: 'chat',
      endpointType: 'chat-completions',
      endpoint: '/chat/completions',
      supportsStreaming: true,
      supportsToolCalls: true,
    },
    'gpt-4o-mini': {
      type: 'chat',
      endpointType: 'chat-completions',
      endpoint: '/chat/completions',
      supportsStreaming: true,
      supportsToolCalls: true,
    },
    'gpt-4-turbo': {
      type: 'chat',
      endpointType: 'chat-completions',
      endpoint: '/chat/completions',
      supportsStreaming: true,
      supportsToolCalls: true,
    },
    'gpt-4': {
      type: 'chat',
      endpointType: 'chat-completions',
      endpoint: '/chat/completions',
      supportsStreaming: true,
      supportsToolCalls: true,
    },
    'gpt-3.5-turbo': {
      type: 'chat',
      endpointType: 'chat-completions',
      endpoint: '/chat/completions',
      supportsStreaming: true,
      supportsToolCalls: true,
    },
  };

  static detect(modelName: string): ModelEndpointConfig {
    if (this.modelConfigs[modelName]) {
      return this.modelConfigs[modelName];
    }
    const config = this.guessFromName(modelName);
    console.log(`[ModelDetection] Unknown model "${modelName}", guessing type: ${config.type}`);
    return config;
  }

  private static guessFromName(modelName: string): ModelEndpointConfig {
    const lowerName = modelName.toLowerCase();

    if (lowerName.includes('o1') || lowerName.includes('o3') || (lowerName.includes('5.5') && lowerName.includes('pro'))) {
      return {
        type: 'reasoning',
        endpointType: 'responses',
        endpoint: '/responses',
        supportsStreaming: false,
        supportsToolCalls: true,
        requestTransform: 'responses',
      };
    }

    if (lowerName.includes('5-codex') || lowerName.includes('5.4-codex')) {
      return {
        type: 'code',
        endpointType: 'responses',
        endpoint: '/responses',
        supportsStreaming: false,
        supportsToolCalls: true,
        requestTransform: 'responses',
      };
    }

    if (lowerName.includes('codex') && lowerName.includes('5.3')) {
      return {
        type: 'code',
        endpointType: 'completions',
        endpoint: '/completions',
        supportsStreaming: true,
        supportsToolCalls: false,
      };
    }

    return {
      type: 'chat',
      endpointType: 'chat-completions',
      endpoint: '/chat/completions',
      supportsStreaming: true,
      supportsToolCalls: true,
    };
  }

  static usesResponsesAPI(modelName: string): boolean {
    return this.detect(modelName).endpointType === 'responses';
  }

  static getEndpoint(modelName: string): string {
    return this.detect(modelName).endpoint;
  }

  static getEndpointType(modelName: string): EndpointType {
    return this.detect(modelName).endpointType;
  }

  static getFullEndpoint(baseUrl: string, modelName: string): string {
    const endpoint = this.getEndpoint(modelName);
    return `${baseUrl}${endpoint}`;
  }

  /**
   * Check if model uses 'max_completion_tokens' instead of 'max_tokens'.
   * Newer models (gpt-5.x, etc.) use this parameter.
   */
  static usesMaxCompletionTokens(modelName: string): boolean {
    const lowerName = modelName.toLowerCase();
    // Newer models: gpt-5.x, o1, o3, gpt-5.x-codex, etc.
    return /gpt-5|o[0-9]/.test(lowerName);
  }
}
