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
          .filter(m => /^(gpt-|o[0-9])/.test(m.id))
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
      { value: 'gpt-4.1', label: 'GPT-4.1', description: 'Latest GPT model' },
      { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini', description: 'Lightweight GPT model' },
      { value: 'gpt-4o', label: 'GPT-4o', description: 'Multimodal model' },
      { value: 'gpt-4o-mini', label: 'GPT-4o Mini', description: 'Fast multimodal model' },
    ];
  }
}
