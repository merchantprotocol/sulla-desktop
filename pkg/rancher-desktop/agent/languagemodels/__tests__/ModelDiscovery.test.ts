/**
 * Dynamic Model Discovery Tests
 *
 * Tests the ModelDiscoveryService functionality for fetching models
 * from various LLM providers dynamically via their APIs
 */

import { modelDiscoveryService, ModelInfo } from '../ModelDiscoveryService';
import { fetchAllAvailableModels, fetchModelsForProvider, getSupportedProviders } from '../index';

// Mock fetch globally
global.fetch = jest.fn();
const mockFetch = global.fetch as jest.MockedFunction<typeof fetch>;

describe('ModelDiscoveryService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    modelDiscoveryService.clearCache();
  });

  describe('Provider Support', () => {
    it('should return list of supported providers', () => {
      const providers = getSupportedProviders();

      expect(providers).toContain('openai');
      expect(providers).toContain('anthropic');
      expect(providers).toContain('google');
      expect(providers).toContain('grok');
      expect(providers).toContain('kimi');
      expect(providers).toContain('nvidia');
    });
  });

  describe('OpenAI Model Fetching', () => {
    it('should fetch OpenAI models successfully', async() => {
      // Mock successful OpenAI API response
      const mockResponse = {
        data: [
          { id: 'gpt-4o', capabilities: ['chat', 'vision'] },
          { id: 'gpt-4o-mini', capabilities: ['chat'] },
          { id: 'gpt-3.5-turbo', capabilities: ['chat'] },
          { id: 'gpt-4-turbo', capabilities: ['chat', 'vision'] },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok:     true,
        status: 200,
        json:   async() => mockResponse,
      } as Response);

      const models = await fetchModelsForProvider('openai', 'test-key');

      expect(models).toHaveLength(4);
      expect(models[0]).toEqual({
        id:           'gpt-4o',
        name:         'gpt-4o',
        provider:     'openai',
        capabilities: ['chat', 'vision'],
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/models',
        expect.objectContaining({
          method:  'GET',
          headers: expect.objectContaining({
            Authorization:  'Bearer test-key',
            'Content-Type':  'application/json',
          }),
        }),
      );
    });

    it('should handle OpenAI API errors gracefully', async() => {
      mockFetch.mockResolvedValueOnce({
        ok:         false,
        status:     401,
        statusText: 'Unauthorized',
      } as Response);

      await expect(fetchModelsForProvider('openai', 'invalid-key'))
        .rejects.toThrow('Invalid API key for openai');
    });
  });

  describe('Anthropic Model Fetching', () => {
    it('should return hardcoded Anthropic models', async() => {
      const models = await fetchModelsForProvider('anthropic', 'test-key');

      expect(models).toHaveLength(5);
      expect(models.some(m => m.id === 'claude-3-5-sonnet-20241022')).toBe(true);
      expect(models.some(m => m.id === 'claude-3-opus-20240229')).toBe(true);
      expect(models.some(m => m.id === 'claude-3-5-haiku-20241022')).toBe(true);

      // Should not make network request for Anthropic
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('Google Model Fetching', () => {
    it('should fetch Google models successfully', async() => {
      const mockResponse = {
        models: [
          {
            name:                       'models/gemini-1.5-pro',
            displayName:                'Gemini 1.5 Pro',
            supportedGenerationMethods: ['generateContent'],
          },
          {
            name:                       'models/gemini-1.5-flash',
            displayName:                'Gemini 1.5 Flash',
            supportedGenerationMethods: ['generateContent'],
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok:     true,
        status: 200,
        json:   async() => mockResponse,
      } as Response);

      const models = await fetchModelsForProvider('google', 'test-key');

      expect(models).toHaveLength(2);
      expect(models[0]).toEqual({
        id:           'gemini-1.5-pro',
        name:         'Gemini 1.5 Pro',
        provider:     'google',
        capabilities: ['generateContent'],
      });
    });
  });

  describe('Caching', () => {
    it('should cache model results', async() => {
      const mockResponse = {
        data: [
          { id: 'gpt-4o', capabilities: ['chat'] },
        ],
      };

      mockFetch.mockResolvedValue({
        ok:     true,
        status: 200,
        json:   async() => mockResponse,
      } as Response);

      // First call
      const models1 = await fetchModelsForProvider('openai', 'test-key');

      // Second call should use cache
      const models2 = await fetchModelsForProvider('openai', 'test-key');

      expect(models1).toEqual(models2);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should provide cache statistics', () => {
      const stats = modelDiscoveryService.getCacheStats();
      expect(stats).toHaveProperty('size');
      expect(stats).toHaveProperty('providers');
      expect(Array.isArray(stats.providers)).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle network timeouts', async() => {
      mockFetch.mockRejectedValueOnce(new Error('Network timeout'));

      const models = await fetchModelsForProvider('openai', 'test-key');

      // Should return empty array on network failure
      expect(models).toEqual([]);
    });

    it('should handle invalid JSON responses', async() => {
      mockFetch.mockResolvedValueOnce({
        ok:     true,
        status: 200,
        json:   async() => { throw new Error('Invalid JSON') },
      } as Response);

      const models = await fetchModelsForProvider('grok', 'test-key');

      expect(models).toEqual([]);
    });

    it('should throw error for unsupported providers', async() => {
      await expect(fetchModelsForProvider('unsupported', 'test-key'))
        .rejects.toThrow('Unsupported provider: unsupported');
    });
  });

  describe('Integration', () => {
    it('should work with LLM registry integration', async() => {
      // Mock multiple providers
      const openaiResponse = {
        data: [{ id: 'gpt-4o', capabilities: ['chat'] }],
      };

      const grokResponse = {
        data: [{ id: 'grok-4-1-fast-reasoning' }],
      };

      mockFetch
        .mockResolvedValueOnce({
          ok:     true,
          status: 200,
          json:   async() => openaiResponse,
        } as Response)
        .mockResolvedValueOnce({
          ok:     true,
          status: 200,
          json:   async() => grokResponse,
        } as Response);

      // This would normally get API keys from settings, but we'll test the service directly
      const allModels = await modelDiscoveryService.fetchAllAvailableModels({
        openai: 'openai-key',
        grok:   'grok-key',
      });

      expect(allModels).toHaveLength(2);
      expect(allModels.some(m => m.id === 'gpt-4o')).toBe(true);
      expect(allModels.some(m => m.id === 'grok-4-1-fast-reasoning')).toBe(true);
    });
  });
});

describe('Real-world Usage Examples', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    modelDiscoveryService.clearCache();
  });

  it('should demonstrate typical usage flow', async() => {
    // 1. Get supported providers
    const providers = getSupportedProviders();
    console.log('Supported providers:', providers);

    // 2. Mock fetching models for Anthropic (no API call)
    const anthropicModels = await fetchModelsForProvider('anthropic', 'fake-key');
    expect(anthropicModels.length).toBeGreaterThan(0);
    expect(anthropicModels[0].provider).toBe('anthropic');

    // 3. Cache should be populated
    const cacheStats = modelDiscoveryService.getCacheStats();
    expect(cacheStats.size).toBeGreaterThan(0);
    expect(cacheStats.providers).toContain('anthropic');

    console.log('Cache stats:', cacheStats);
    console.log('Available Claude models:', anthropicModels.map(m => m.name));
  });
});
