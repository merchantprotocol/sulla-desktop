import { SelectBoxProvider, type SelectBoxContext, type SelectOption } from './SelectBoxProvider';

export class OpenAIModels extends SelectBoxProvider {
  readonly id = 'openai_models';

  async getOptions(context: SelectBoxContext): Promise<SelectOption[]> {
    const apiKey = context.formValues.api_key;

    if (!apiKey) {
      return this.getStaticModels();
    }

    try {
      const response = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${ apiKey }` },
      });

      if (!response.ok) {
        return this.getStaticModels();
      }

      const body = await response.json() as { data?: { id: string }[] };

      if (body.data && body.data.length > 0) {
        return body.data
          .sort((a, b) => a.id.localeCompare(b.id))
          .map(m => ({ value: m.id, label: m.id }));
      }
    } catch {
      // Fall back to static list
    }

    return this.getStaticModels();
  }

  private getStaticModels(): SelectOption[] {
    return [
      { value: 'o3', label: 'o3', description: 'Latest reasoning model' },
      { value: 'o3-mini', label: 'o3-mini', description: 'Lightweight reasoning model' },
      { value: 'o1', label: 'o1', description: 'Advanced reasoning model' },
      { value: 'o1-mini', label: 'o1-mini', description: 'Fast reasoning model' },
      { value: 'gpt-4o', label: 'GPT-4o', description: 'Most capable multimodal model' },
      { value: 'gpt-4o-mini', label: 'GPT-4o Mini', description: 'Fast multimodal model' },
      { value: 'gpt-4-turbo', label: 'GPT-4 Turbo', description: 'High capability model' },
      { value: 'gpt-4', label: 'GPT-4', description: 'Original GPT-4 model' },
      { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo', description: 'Fast and affordable model' },
    ];
  }
}
