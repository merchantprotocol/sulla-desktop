// SPDX-License-Identifier: GPL-2.0-or-later
import { InfrastructureFailure } from './providerRecovery';

import type { BaseThreadState } from '../nodes/Graph';

/** Verify the actual auth lane, not a provider label, before any mapped provider request. */
export function assertWorkerSubscription(
  state: BaseThreadState | undefined,
  provider: string,
  integration: string,
  account: string,
  authMode?: string,
  request?: { model?: string; url?: string },
): void {
  const meta = state?.metadata as any;
  const route = !meta?.workerModelChatOverride && meta?.workerModelRoute;
  const override = !meta?.workerModelChatOverride && meta?.modelOverride?.provider === 'grok' ? meta.modelOverride : undefined;
  if (!route && !override) return;
  if (override && provider !== 'grok') throw new InfrastructureFailure('The Grok launch override cannot authorize a different provider.');
  if (provider === 'grok') {
    let subscriptionEndpoint = false;
    try {
      const url = new URL(request?.url ?? '');
      subscriptionEndpoint = url.protocol === 'https:' && url.hostname === 'cli-chat-proxy.grok.com' && url.pathname.startsWith('/v1/');
    } catch { /* invalid URL fails closed below */ }
    const selected = route?.candidates?.[route.selected];
    const expectedModel = override?.model ?? (selected?.provider === 'grok' ? selected.model : undefined);
    const expectedAccount = override?.connections?.grok ?? route?.connections?.grok;
    if (integration !== 'grok' || expectedAccount !== account || authMode !== 'oauth' ||
        !expectedModel || !request?.model || expectedModel !== request.model || !subscriptionEndpoint) {
      throw new InfrastructureFailure(override
        ? 'The Grok launch override no longer matches its approved OAuth account, subscription endpoint, and exact model.'
        : 'The mapped Grok request no longer matches its approved OAuth account, subscription endpoint, and exact model. Update its mapping in AI Models.');
    }
    return;
  }
  if (!['codex', 'claude-code'].includes(provider) || integration !== provider || route.connections?.[provider] !== account || (provider === 'claude-code' && authMode !== 'oauth')) throw new InfrastructureFailure('The worker subscription connection changed or is unavailable. Update its mapping in AI Models.');
}
