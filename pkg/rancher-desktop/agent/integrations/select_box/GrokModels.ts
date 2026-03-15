import { SelectBoxProvider, type SelectBoxContext, type SelectOption } from './SelectBoxProvider';

export class GrokModels extends SelectBoxProvider {
  readonly id = 'grok_models';

  async getOptions(context: SelectBoxContext): Promise<SelectOption[]> {
    const apiKey = context.formValues.api_key;

    if (!apiKey) {
      return this.getStaticModels();
    }

    try {
      const response = await fetch('https://api.x.ai/v1/models', {
        headers: { Authorization: `Bearer ${ apiKey }` },
      });

      if (!response.ok) {
        return this.getStaticModels();
      }

      const body = await response.json() as { data?: { id: string }[] };

      if (body.data && body.data.length > 0) {
        return body.data.map(m => ({ value: m.id, label: m.id }));
      }
    } catch {
      // Fall back to static list
    }

    return this.getStaticModels();
  }

  private getStaticModels(): SelectOption[] {
    return [
      { value: 'grok-3', label: 'Grok 3', description: 'Latest flagship model' },
      { value: 'grok-3-mini', label: 'Grok 3 Mini', description: 'Lightweight reasoning model' },
      { value: 'grok-2', label: 'Grok 2', description: 'Previous generation flagship' },
    ];
  }
}
