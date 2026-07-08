import { SelectBoxProvider, type SelectBoxContext, type SelectOption } from './SelectBoxProvider';

export class GrokModels extends SelectBoxProvider {
  readonly id = 'grok_models';

  async getOptions(context: SelectBoxContext): Promise<SelectOption[]> {
    let bearer = context.formValues.api_key;

    // No pasted API key — the account may be OAuth-connected (Sign in with
    // Grok). The OAuth access token is a standard Bearer credential on
    // api.x.ai, so the live model list works for it too.
    if (!bearer) {
      try {
        const { getOAuthService } = await import('../../services/OAuthService');
        bearer = await getOAuthService().getAccessToken(context.integrationId, context.accountId);
      } catch { /* no OAuth session either */ }
    }

    if (!bearer) {
      return this.getStaticModels();
    }

    try {
      const response = await fetch('https://api.x.ai/v1/models', {
        headers: { Authorization: `Bearer ${ bearer }` },
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
