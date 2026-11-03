// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SelectBoxProvider, type SelectBoxContext, type SelectOption } from './SelectBoxProvider';
import { usesContainerVaultAuthority } from '../../../vault-broker';
import { listProviderModelsBrokered } from '../../services/brokeredModelList';
import { getPendingCredential } from '../../../main/firstRun/pendingCredentials';
import Logging from '@pkg/utils/logging';

const log = Logging.background;

interface GrokModelsBody { data?: { id: string; name?: string; description?: string }[] }

function parseGrokModels(body: GrokModelsBody | null): SelectOption[] {
  if (!body || !Array.isArray(body.data)) return [];
  return body.data
    .filter(m => m && typeof m.id === 'string' && m.id)
    .map(m => ({ value: m.id, label: m.name || m.id, description: m.description }));
}

export class GrokModels extends SelectBoxProvider {
  readonly id = 'grok_models';

  async getOptions(context: SelectBoxContext): Promise<SelectOption[]> {
    const pendingToken = getPendingCredential('grok')?.values.access_token;
    if (pendingToken) return this.getPendingOAuthOptions(pendingToken);

    if (usesContainerVaultAuthority()) return this.getBrokeredOptions(context);

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
      log.warn('[GrokModels] No credential is available for live model discovery');
      return [];
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
        log.warn(`[GrokModels] Live model request returned ${ response.status }`);
        return [];
      }

      const body = await response.json() as { data?: { id: string; name?: string; description?: string }[] };

      if (body.data && body.data.length > 0) {
        return body.data.map(m => ({
          value:       m.id,
          label:       m.name || m.id,
          description: m.description,
        }));
      }
    } catch (err) {
      log.warn(`[GrokModels] Live model request failed: ${ err }`);
    }

    log.warn('[GrokModels] Live model request returned no models');
    return [];
  }

  private async getPendingOAuthOptions(accessToken: string): Promise<SelectOption[]> {
    try {
      const { GROK_SUBSCRIPTION_BASE_URL, grokCliHeaders } = await import('../../languagemodels/GrokService');
      const response = await fetch(`${ GROK_SUBSCRIPTION_BASE_URL }/models`, {
        headers: { Authorization: `Bearer ${ accessToken }`, ...grokCliHeaders() },
      });
      if (!response.ok) {
        log.warn(`[GrokModels] Pending-credential model request returned ${ response.status }`);
        return [];
      }
      const models = parseGrokModels(await response.json() as GrokModelsBody);
      if (!models.length) log.warn('[GrokModels] Pending-credential model request returned no models');
      return models;
    } catch (err) {
      log.warn(`[GrokModels] Pending-credential model request failed: ${ err }`);
      return [];
    }
  }

  /**
   * Container vault: the app holds no Grok credential, so list the catalog
   * through the vault broker on the account's own lane (OAuth → subscription
   * proxy, API key → api.x.ai). A failed live request returns no models.
   */
  private async getBrokeredOptions(context: SelectBoxContext): Promise<SelectOption[]> {
    const { grokCliHeaders } = await import('../../languagemodels/GrokService');
    const { body, lane } = await listProviderModelsBrokered<GrokModelsBody>(
      'grok',
      context.accountId,
      // The proxy 426s requests without grok-cli identification headers.
      candidate => (candidate.oauth ? grokCliHeaders() : {}),
    );
    const live = parseGrokModels(body);
    if (!live.length) log.warn(`[GrokModels] Brokered live model request returned no models${ lane ? ` for the ${ lane.oauth ? 'subscription' : 'metered' } lane` : '' }`);
    return live;
  }
}
