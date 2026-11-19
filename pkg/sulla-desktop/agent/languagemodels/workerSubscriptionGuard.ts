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
  if (!route) return;
  if (provider === 'grok') {
    let subscriptionEndpoint = false;
    try {
      const url = new URL(request?.url ?? '');
      subscriptionEndpoint = url.protocol === 'https:' && url.hostname === 'cli-chat-proxy.grok.com' && url.pathname.startsWith('/v1/');
    } catch { /* invalid URL fails closed below */ }
    const selected = route.candidates?.[route.selected];
    if (integration !== 'grok' || route.connections?.grok !== account || authMode !== 'oauth' ||
        selected?.provider !== 'grok' || !request?.model || selected.model !== request.model || !subscriptionEndpoint) {
      throw new InfrastructureFailure('The mapped Grok request no longer matches its approved OAuth account, subscription endpoint, and exact model. Update its mapping in AI Models.');
    }
    return;
  }
  if (!['codex', 'claude-code'].includes(provider) || integration !== provider || route.connections?.[provider] !== account || (provider === 'claude-code' && authMode !== 'oauth')) throw new InfrastructureFailure('The worker subscription connection changed or is unavailable. Update its mapping in AI Models.');
}
