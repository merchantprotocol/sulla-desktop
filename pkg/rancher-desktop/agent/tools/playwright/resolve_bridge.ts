/**
 * resolve_bridge.ts
 *
 * Shared helper for all playwright tools. Resolves a bridge from the
 * main-process proxy by optional assetId, falling back to the currently
 * active asset.
 *
 * Because the real bridges live in the renderer, every call goes through
 * HostBridgeProxy which forwards via WebSocket.
 */

import { hostBridgeProxy, ProxyBridge } from '../../scripts/injected/HostBridgeProxy';
import type { ToolResponse } from '../base';

export interface BridgeResolution {
  bridge:  ProxyBridge;
  assetId: string;
}

/**
 * Resolves a bridge from the proxy.
 * Returns either a successful BridgeResolution or a ToolResponse error.
 *
 * NOTE: This is async because it queries the renderer via WebSocket.
 */
export async function resolveBridge(assetId?: string): Promise<BridgeResolution | ToolResponse> {
  const targetId = (assetId?.trim()) || (await hostBridgeProxy.getActiveAssetId()) || '';
  const allAssets = await hostBridgeProxy.getAllAssetInfo();

  console.log('[SULLA_RESOLVE_BRIDGE]', {
    requestedAssetId: assetId,
    resolvedTargetId: targetId,
    registrySize:     allAssets.length,
    activeAssetId:    await hostBridgeProxy.getActiveAssetId(),
  });

  // Find the target asset in the registry
  const found = targetId
    ? allAssets.find(a => a.assetId === targetId)
    : allAssets.find(a => a.isInjected); // fallback: first injected asset

  if (!found) {
    if (allAssets.length === 0) {
      return {
        successBoolean: false,
        responseString: 'No active website assets. Ensure at least one iframe asset is open and active.',
      };
    }

    const available = allAssets
      .map(e => `  - ${ e.assetId } "${ e.title }" (${ e.url })`)
      .join('\n');

    return {
      successBoolean: false,
      responseString: `Asset "${ assetId }" not found. Available assets:\n${ available }\nUse list_active_pages to see all open websites.`,
    };
  }

  if (!found.isInjected) {
    return {
      successBoolean: false,
      responseString: `Guest bridge for "${ found.assetId }" not yet injected. The page may still be loading.`,
    };
  }

  console.log('[SULLA_RESOLVE_BRIDGE] resolved', { assetId: found.assetId, injected: found.isInjected });

  return { bridge: hostBridgeProxy.resolve(found.assetId), assetId: found.assetId };
}

/**
 * Type guard to distinguish a successful resolution from a ToolResponse error.
 */
export function isBridgeResolved(result: BridgeResolution | ToolResponse): result is BridgeResolution {
  return 'bridge' in result;
}
