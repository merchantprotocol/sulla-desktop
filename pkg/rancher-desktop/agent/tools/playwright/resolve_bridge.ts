/**
 * resolve_bridge.ts
 *
 * Shared helper for all playwright tools. Resolves a WebviewHostBridge
 * from the multi-asset registry by optional assetId, falling back to
 * the currently active asset.
 */

import { hostBridgeRegistry } from '../../scripts/injected/HostBridgeRegistry';
import type { WebviewHostBridge } from '../../scripts/injected/WebviewHostBridge';
import type { ToolResponse } from '../base';

export interface BridgeResolution {
  bridge:  WebviewHostBridge;
  assetId: string;
}

/**
 * Resolves a bridge from the registry.
 * Returns either a successful BridgeResolution or a ToolResponse error.
 */
export function resolveBridge(assetId?: string): BridgeResolution | ToolResponse {
  const targetId = (assetId?.trim()) || hostBridgeRegistry.getActiveAssetId() || '';
  console.log('[SULLA_RESOLVE_BRIDGE]', { requestedAssetId: assetId, resolvedTargetId: targetId, registrySize: hostBridgeRegistry.size(), activeAssetId: hostBridgeRegistry.getActiveAssetId() });
  const bridge = hostBridgeRegistry.resolve(targetId || undefined);
  console.log('[SULLA_RESOLVE_BRIDGE] resolve result', { found: !!bridge, injected: bridge?.isInjected?.() });

  if (!bridge) {
    const count = hostBridgeRegistry.size();
    if (count === 0) {
      return {
        successBoolean: false,
        responseString: 'No active website assets. Ensure at least one iframe asset is open and active.',
      };
    }

    const available = hostBridgeRegistry.getAllEntries()
      .map(e => `  - ${ e.assetId } "${ e.title }" (${ e.url })`)
      .join('\n');

    return {
      successBoolean: false,
      responseString: `Asset "${ assetId }" not found. Available assets:\n${ available }\nUse list_active_pages to see all open websites.`,
    };
  }

  if (!bridge.isInjected()) {
    return {
      successBoolean: false,
      responseString: `Guest bridge for "${ targetId }" not yet injected. The page may still be loading.`,
    };
  }

  return { bridge, assetId: targetId };
}

/**
 * Type guard to distinguish a successful resolution from a ToolResponse error.
 */
export function isBridgeResolved(result: BridgeResolution | ToolResponse): result is BridgeResolution {
  return 'bridge' in result;
}
