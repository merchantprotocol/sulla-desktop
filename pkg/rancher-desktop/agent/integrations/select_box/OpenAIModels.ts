import { SelectBoxProvider, type SelectBoxContext, type SelectOption } from './SelectBoxProvider';

export class OpenAIModels extends SelectBoxProvider {
  readonly id = 'openai_models';

  async getOptions(context: SelectBoxContext): Promise<SelectOption[]> {
    const apiKey = context.formValues.api_key;

    if (!apiKey) {
      return [];
    }

    try {
      const response = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${ apiKey }` },
      });

      if (!response.ok) {
        console.warn(`[OpenAIModels] API call failed: ${ response.status } ${ response.statusText }`);
        return [];
      }

      const body = await response.json() as { data?: { id: string }[] };

      if (body.data && body.data.length > 0) {
        console.log(`[OpenAIModels] Got ${ body.data.length } models from OpenAI API`);
        return body.data
          .sort((a, b) => a.id.localeCompare(b.id))
          .map(m => ({ value: m.id, label: m.id }));
      }

      console.warn('[OpenAIModels] API returned no data');
    } catch (err) {
      console.error('[OpenAIModels] API call failed:', err);
    }

    return [];
  }
}
