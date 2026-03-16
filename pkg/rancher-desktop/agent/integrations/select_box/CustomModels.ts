import { SelectBoxProvider, type SelectBoxContext, type SelectOption } from './SelectBoxProvider';

export class CustomModels extends SelectBoxProvider {
  readonly id = 'custom_models';

  async getOptions(context: SelectBoxContext): Promise<SelectOption[]> {
    const baseUrl = context.formValues.base_url;

    if (!baseUrl) {
      return [];
    }

    try {
      const url = baseUrl.replace(/\/+$/, '') + '/models';
      const headers: Record<string, string> = {};
      const apiKey = context.formValues.api_key;

      if (apiKey) {
        headers.Authorization = `Bearer ${ apiKey }`;
      }

      const response = await fetch(url, { headers });

      if (!response.ok) {
        return [];
      }

      const body = await response.json() as { data?: { id: string }[] };

      if (body.data && body.data.length > 0) {
        return body.data.map(m => ({ value: m.id, label: m.id }));
      }
    } catch {
      // Endpoint unreachable or invalid response
    }

    return [];
  }
}
