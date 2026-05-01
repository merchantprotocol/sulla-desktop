import { SelectBoxProvider, type SelectBoxContext, type SelectOption } from './SelectBoxProvider';

/**
 * Arcee AI models select box provider.
 * Fetches available models from Arcee API or returns static list.
 *
 * Models: Trinity Large Thinking, Trinity Mini, Trinity Large Preview
 * Supports tool use
 */
export class ArceeModels extends SelectBoxProvider {
  readonly id = 'arcee_models';

  async getOptions(context: SelectBoxContext): Promise<SelectOption[]> {
    const apiKey = context.formValues.api_key;
    const staticModels = this.getStaticModels();

    if (!apiKey) {
      return staticModels;
    }

    try {
      const response = await fetch('https://api.arcee.ai/api/v1/models', {
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
        return body.data.map(m => ({
          value: m.id,
          label: this.getModelLabel(m.id),
          description: m.description || this.getModelDescription(m.id),
        }));
      }
    } catch {
      // Fall back to static list
    }

    return staticModels;
  }

  private getStaticModels(): SelectOption[] {
    return [
      {
        value: 'trinity-large-thinking',
        label: 'Trinity Large Thinking',
        description: 'Arcee\'s most capable thinking model - tool use, reasoning, coding',
      },
      {
        value: 'trinity-large-preview',
        label: 'Trinity Large Preview',
        description: 'Preview of latest improvements - tool use, reasoning, coding',
      },
      {
        value: 'trinity-mini',
        label: 'Trinity Mini',
        description: 'Fast, efficient model - tool use, quick tasks',
      },
    ];
  }

  private getModelLabel(modelName: string): string {
    const labels: Record<string, string> = {
      'trinity-large-thinking': 'Trinity Large Thinking',
      'trinity-large-preview': 'Trinity Large Preview',
      'trinity-mini': 'Trinity Mini',
    };

    return labels[modelName] || modelName;
  }

  private getModelDescription(modelName: string): string | undefined {
    const descriptions: Record<string, string> = {
      'trinity-large-thinking': 'Arcee\'s most capable thinking model - tool use, reasoning, coding',
      'trinity-large-preview': 'Preview of latest improvements - tool use, reasoning, coding',
      'trinity-mini': 'Fast, efficient model - tool use, quick tasks',
    };

    return descriptions[modelName];
  }
}
