import { SelectBoxProvider, type SelectBoxContext, type SelectOption } from './SelectBoxProvider';

export class GrokModels extends SelectBoxProvider {
  readonly id = 'grok_models';

  async getOptions(context: SelectBoxContext): Promise<SelectOption[]> {
    const apiKey = context.formValues.api_key;

    // OAuth session (Sign in with Grok) → list the SUBSCRIPTION lane catalog
    // from the grok-cli proxy. The metered api.x.ai catalog is wrong for
    // OAuth accounts: those models 403 on the subscription lane and vice
    // versa (see GrokService for the two-lane explanation).
    let oauthToken = '';
    if (!apiKey) {
      try {
        const { getOAuthService } = await import('../../services/OAuthService');
        oauthToken = await getOAuthService().getAccessToken(context.integrationId, context.accountId);
      } catch { /* no OAuth session either */ }
    }

    const bearer = apiKey || oauthToken;
    if (!bearer) {
      return this.getStaticModels(false);
    }

    try {
      const { GROK_METERED_BASE_URL, GROK_SUBSCRIPTION_BASE_URL, grokCliHeaders } = await import('../../languagemodels/GrokService');
      const url = oauthToken ? `${ GROK_SUBSCRIPTION_BASE_URL }/models` : `${ GROK_METERED_BASE_URL }/models`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${ bearer }`,
          // The proxy 426s requests without grok-cli identification headers.
          ...(oauthToken ? grokCliHeaders() : {}),
        },
      });

      if (!response.ok) {
        return this.getStaticModels(!!oauthToken);
      }

      const body = await response.json() as { data?: { id: string; name?: string; description?: string }[] };

      if (body.data && body.data.length > 0) {
        return body.data.map(m => ({
          value:       m.id,
          label:       m.name || m.id,
          description: m.description,
        }));
      }
    } catch {
      // Fall back to static list
    }

    return this.getStaticModels(!!oauthToken);
  }

  private getStaticModels(oauthMode: boolean): SelectOption[] {
    if (oauthMode) {
      // Subscription-lane catalog observed 2026-07; the live fetch above is
      // authoritative, this is only an offline fallback.
      return [
        { value: 'grok-4.5', label: 'Grok 4.5', description: 'Frontier model, 500k context' },
        { value: 'grok-composer-2.5-fast', label: 'Composer 2.5', description: 'Fast coding model, 200k context' },
      ];
    }

    return [
      { value: 'grok-3', label: 'Grok 3', description: 'Latest flagship model' },
      { value: 'grok-3-mini', label: 'Grok 3 Mini', description: 'Lightweight reasoning model' },
      { value: 'grok-2', label: 'Grok 2', description: 'Previous generation flagship' },
    ];
  }
}
