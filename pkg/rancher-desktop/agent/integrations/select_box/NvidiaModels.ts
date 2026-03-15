import { SelectBoxProvider, type SelectBoxContext, type SelectOption } from './SelectBoxProvider';

export class NvidiaModels extends SelectBoxProvider {
  readonly id = 'nvidia_models';

  async getOptions(context: SelectBoxContext): Promise<SelectOption[]> {
    const apiKey = context.formValues.api_key;

    if (!apiKey) {
      return this.getStaticModels();
    }

    try {
      const response = await fetch('https://integrate.api.nvidia.com/v1/models', {
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
      { value: 'meta/llama-3.3-70b-instruct', label: 'Llama 3.3 70B Instruct' },
      { value: 'meta/llama-3.1-405b-instruct', label: 'Llama 3.1 405B Instruct' },
      { value: 'nvidia/llama-3.1-nemotron-70b-instruct', label: 'Nemotron 70B Instruct' },
      { value: 'mistralai/mixtral-8x22b-instruct-v0.1', label: 'Mixtral 8x22B Instruct' },
    ];
  }
}
