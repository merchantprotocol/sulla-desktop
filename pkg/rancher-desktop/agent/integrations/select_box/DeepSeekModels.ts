import { SelectBoxProvider, type SelectBoxContext, type SelectOption } from './SelectBoxProvider';

/**
 * DeepSeek models select box provider.
 * Fetches available models from DeepSeek API or returns static list.
 *
 * Free tier models: DeepSeek-V3, DeepSeek-R1, DeepSeek-Chat
 * All models support tool use.
 */
export class DeepSeekModels extends SelectBoxProvider {
  readonly id = 'deepseek_models';

  async getOptions(context: SelectBoxContext): Promise<SelectOption[]> {
    const apiKey = context.formValues.api_key;
    const staticModels = this.getStaticModels();

    if (!apiKey) {
      return staticModels;
    }

    try {
      const response = await fetch('https://api.deepseek.com/models', {
        headers: {
          'Authorization': `Bearer ${ apiKey }`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        return staticModels;
      }

      const body = await response.json() as { data?: { id: string; description?: string }[] };

      if (body.data && body.data.length > 0) {
        // Get API models
        const apiModels = body.data.map(m => ({
          value: m.id,
          label: this.getModelLabel(m.id),
          description: m.description || this.getModelDescription(m.id),
        }));

        // Get IDs from API to avoid duplicates
        const apiModelIds = new Set(apiModels.map(m => m.value));

        // Add legacy models that aren't in the API response
        const legacyModels = staticModels.filter(m =>
          (m.value === 'deepseek-chat' || m.value === 'deepseek-reasoner') &&
          !apiModelIds.has(m.value)
        );

        // Return API models + legacy models
        return [...apiModels, ...legacyModels];
      }
    } catch {
      // Fall back to static list
    }

    return staticModels;
  }

  private getStaticModels(): SelectOption[] {
    return [
      {
        value: 'deepseek-v4-flash',
        label: 'DeepSeek V4 Flash',
        description: 'Fast, efficient model - tool use, coding, reasoning (non-thinking mode)',
      },
      {
        value: 'deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        description: 'Most capable model - tool use, complex reasoning, coding',
      },
      // Legacy aliases (to be deprecated 2026/07/24)
      {
        value: 'deepseek-chat',
        label: 'DeepSeek-Chat (Legacy)',
        description: 'TO BE DEPRECATED 2026/07/24 - Maps to V4 Flash non-thinking mode',
      },
      {
        value: 'deepseek-reasoner',
        label: 'DeepSeek-R1 Reasoner (Legacy)',
        description: 'TO BE DEPRECATED 2026/07/24 - Maps to V4 Flash thinking mode',
      },
    ];
  }

  private getModelLabel(modelName: string): string {
    const labels: Record<string, string> = {
      'deepseek-v4-flash': 'DeepSeek V4 Flash',
      'deepseek-v4-pro': 'DeepSeek V4 Pro',
      'deepseek-chat': 'DeepSeek-Chat (Legacy)',
      'deepseek-reasoner': 'DeepSeek-R1 Reasoner (Legacy)',
    };

    return labels[modelName] || modelName;
  }

  private getModelDescription(modelName: string): string | undefined {
    const descriptions: Record<string, string> = {
      'deepseek-v4-flash': 'Fast, efficient model - tool use, coding, reasoning (non-thinking mode)',
      'deepseek-v4-pro': 'Most capable model - tool use, complex reasoning, coding',
      'deepseek-chat': 'TO BE DEPRECATED 2026/07/24 - Maps to V4 Flash non-thinking mode',
      'deepseek-reasoner': 'TO BE DEPRECATED 2026/07/24 - Maps to V4 Flash thinking mode',
      'deepseek-coder': 'TO BE DEPRECATED - Use deepseek-v4-flash or deepseek-v4-pro',
    };

    return descriptions[modelName];
  }
}
