import { SelectBoxProvider, type SelectBoxContext, type SelectOption } from './SelectBoxProvider';

/**
 * Cohere models select box provider.
 * Fetches available models from Cohere API or returns static list.
 *
 * Free tier models: Command R, Command R+, Command A, Aya Expanse
 */
export class CohereModels extends SelectBoxProvider {
  readonly id = 'cohere_models';

  async getOptions(context: SelectBoxContext): Promise<SelectOption[]> {
    const apiKey = context.formValues.api_key;

    if (!apiKey) {
      return this.getStaticModels();
    }

    try {
      const response = await fetch('https://api.cohere.com/v2/models', {
        headers: {
          'Authorization': `Bearer ${ apiKey }`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        return this.getStaticModels();
      }

      const body = await response.json() as { models?: { name: string; description?: string }[] };

      if (body.models && body.models.length > 0) {
        // Filter to only Command models (support tool use)
        // Exclude: Aya, Tiny Aya (no tool support), transcribe, embed, rerank
        const toolCapableModels = body.models.filter(m => {
          const name = m.name.toLowerCase();
          return name.startsWith('command') && !name.includes('transcribe');
        });

        if (toolCapableModels.length > 0) {
          return toolCapableModels
            .map(m => ({
              value: m.name,
              label: m.name,
              description: m.description || this.getModelDescription(m.name),
            }));
        }
      }
    } catch {
      // Fall back to static list
    }

    return this.getStaticModels();
  }

  private getStaticModels(): SelectOption[] {
    return [
      // Command A - Latest flagship (supports tool use)
      {
        value: 'command-a-03-2025',
        label: 'Command A',
        description: 'Latest flagship - tool use, RAG, agents',
      },
      {
        value: 'command-a-reasoning-08-2025',
        label: 'Command A Reasoning',
        description: 'Advanced reasoning - tool use, complex reasoning',
      },
      {
        value: 'command-a-translate-08-2025',
        label: 'Command A Translate',
        description: 'Translation optimized - tool use, multilingual',
      },
      {
        value: 'command-a-vision-07-2025',
        label: 'Command A Vision',
        description: 'Multimodal vision - tool use, image + text',
      },
      // Command R7B - Fast lightweight (supports tool use)
      {
        value: 'command-r7b-12-2024',
        label: 'Command R7B',
        description: 'Fast, lightweight - tool use, RAG, everyday tasks',
      },
      {
        value: 'command-r7b-arabic-02-2025',
        label: 'Command R7B Arabic',
        description: 'Arabic optimized - tool use, fast, lightweight',
      },
      // Command R - Balanced (supports tool use)
      {
        value: 'command-r-08-2024',
        label: 'Command R (08-2024)',
        description: 'Balanced - tool use, conversation, RAG',
      },
      {
        value: 'command-r-03-2024',
        label: 'Command R (03-2024)',
        description: 'Earlier Command R - tool use, conversation',
      },
      {
        value: 'command-r',
        label: 'Command R',
        description: 'Balanced - tool use, everyday tasks',
      },
      // Command R+ - Advanced reasoning (supports tool use)
      {
        value: 'command-r-plus-08-2024',
        label: 'Command R+ (08-2024)',
        description: 'Advanced reasoning - tool use, complex tasks',
      },
      {
        value: 'command-r-plus-04-2024',
        label: 'Command R+ (04-2024)',
        description: 'Earlier Command R+ - tool use, reasoning',
      },
      {
        value: 'command-r-plus',
        label: 'Command R+',
        description: 'Advanced reasoning - tool use, complex tasks',
      },
    ];
  }

  private getModelDescription(modelName: string): string | undefined {
    const descriptions: Record<string, string> = {
      // Command A
      'command-a-03-2025': 'Latest flagship - tool use, RAG, agents',
      'command-a-reasoning-08-2025': 'Advanced reasoning - tool use, complex reasoning',
      'command-a-translate-08-2025': 'Translation optimized - tool use, multilingual',
      'command-a-vision-07-2025': 'Multimodal vision - tool use, image + text',
      // Command R7B
      'command-r7b-12-2024': 'Fast, lightweight - tool use, RAG, everyday tasks',
      'command-r7b-arabic-02-2025': 'Arabic optimized - tool use, fast, lightweight',
      // Command R
      'command-r-08-2024': 'Balanced - tool use, conversation, RAG',
      'command-r-03-2024': 'Earlier Command R - tool use, conversation',
      'command-r': 'Balanced - tool use, everyday tasks',
      // Command R+
      'command-r-plus-08-2024': 'Advanced reasoning - tool use, complex tasks',
      'command-r-plus-04-2024': 'Earlier Command R+ - tool use, reasoning',
      'command-r-plus': 'Advanced reasoning - tool use, complex tasks',
    };

    return descriptions[modelName];
  }
}
