/**
 * resolve_bridge.ts
 *
 * Shared helper for all playwright tools. Resolves a bridge from the
 * main-process proxy by assetId — with fuzzy matching when an exact
 * match isn't found. Never silently returns a different tab's content.
 */

import { hostBridgeProxy, ProxyBridge, AssetInfo } from '../../scripts/injected/HostBridgeProxy';
import type { ToolResponse } from '../base';

export interface BridgeResolution {
  bridge:  ProxyBridge;
  assetId: string;
}

/**
 * Score how well a query matches an asset. Higher = better.
 * Returns 0 for no match.
 */
function matchScore(query: string, asset: AssetInfo): number {
  const q = query.toLowerCase();
  const id = (asset.assetId || '').toLowerCase();
  const title = (asset.title || '').toLowerCase();
  const url = (asset.url || '').toLowerCase();

  // Exact ID match
  if (id === q) return 100;

  // ID contains query or query contains ID
  if (id.includes(q)) return 80;
  if (q.includes(id)) return 70;

  // URL contains query (useful when passing a domain name)
  if (url.includes(q)) return 60;

  // Title contains query
  if (title.includes(q)) return 50;

  // Partial ID overlap — split on common delimiters and check token overlap
  const qTokens = q.split(/[-_\s./]+/).filter(Boolean);
  const idTokens = id.split(/[-_\s./]+/).filter(Boolean);
  const titleTokens = title.split(/[-_\s./]+/).filter(Boolean);
  const allTargetTokens = [...idTokens, ...titleTokens];

  let tokenHits = 0;
  for (const qt of qTokens) {
    if (allTargetTokens.some(t => t.includes(qt) || qt.includes(t))) {
      tokenHits++;
    }
  }
  if (tokenHits > 0 && qTokens.length > 0) {
    return 20 + Math.round((tokenHits / qTokens.length) * 20);
  }

  return 0;
}

function formatAssetLine(a: AssetInfo): string {
  const status = a.isInjected ? 'ready' : 'loading';
  return `  - \`${ a.assetId }\` "${ a.title }" (${ a.url }) [${ status }]`;
}

/**
 * Resolves a bridge from the proxy.
 *
 * When assetId is provided:
 *   1. Exact match → return it
 *   2. No exact match → fuzzy search by ID, title, URL
 *   3. Single close match → return it with a note
 *   4. Multiple close matches → return an error listing them
 *   5. No matches at all → return error with all available assets
 *
 * When assetId is omitted → returns the currently active asset.
 * Never silently returns content from the wrong tab.
 */
export async function resolveBridge(assetId?: string): Promise<BridgeResolution | ToolResponse> {
  const allAssets = await hostBridgeProxy.getAllAssetInfo();

  // No assets at all
  if (allAssets.length === 0) {
    return {
      successBoolean: false,
      responseString: 'No browser tabs open. Open one first with browser_tab(action: "upsert", assetType: "iframe", url: "...").',
    };
  }

  // No assetId provided — use the active asset
  if (!assetId || !assetId.trim()) {
    const activeId = await hostBridgeProxy.getActiveAssetId();
    const active = activeId ? allAssets.find(a => a.assetId === activeId) : null;

    if (active && active.isInjected) {
      return { bridge: hostBridgeProxy.resolve(active.assetId), assetId: active.assetId };
    }

    // No active — if there's exactly one injected asset, use it
    const injected = allAssets.filter(a => a.isInjected);
    if (injected.length === 1) {
      return { bridge: hostBridgeProxy.resolve(injected[0].assetId), assetId: injected[0].assetId };
    }

    if (injected.length > 1) {
      const list = injected.map(formatAssetLine).join('\n');
      return {
        successBoolean: false,
        responseString: `Multiple tabs are open. Specify which one with the assetId parameter:\n${ list }`,
      };
    }

    return {
      successBoolean: false,
      responseString: 'No tabs are ready yet. All may still be loading. Wait and try again.',
    };
  }

  // assetId provided — try to match
  const query = assetId.trim();

  // 1. Exact match
  const exact = allAssets.find(a => a.assetId === query);
  if (exact) {
    if (!exact.isInjected) {
      return {
        successBoolean: false,
        responseString: `Tab "${ exact.assetId }" is still loading (bridge not yet injected). Wait a few seconds and try again.`,
      };
    }
    return { bridge: hostBridgeProxy.resolve(exact.assetId), assetId: exact.assetId };
  }

  // 2. Fuzzy match
  const scored = allAssets
    .map(a => ({ asset: a, score: matchScore(query, a) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);

  // Single strong match
  if (scored.length === 1 || (scored.length > 1 && scored[0].score >= 60 && scored[0].score > scored[1].score + 20)) {
    const best = scored[0].asset;
    if (!best.isInjected) {
      return {
        successBoolean: false,
        responseString: `Matched "${ query }" → "${ best.assetId }" but it's still loading. Wait a few seconds.`,
      };
    }
    return { bridge: hostBridgeProxy.resolve(best.assetId), assetId: best.assetId };
  }

  // Multiple close matches
  if (scored.length > 1) {
    const list = scored.slice(0, 5).map(s => `${ formatAssetLine(s.asset) } (match: ${ s.score }%)`).join('\n');
    return {
      successBoolean: false,
      responseString: `Asset "${ query }" not found. Multiple close matches — did you mean one of these?\n${ list }`,
    };
  }

  // No matches at all
  const available = allAssets.map(formatAssetLine).join('\n');
  return {
    successBoolean: false,
    responseString: `Asset "${ query }" not found and no close matches.\n\nAvailable tabs:\n${ available }`,
  };
}

/**
 * Type guard to distinguish a successful resolution from a ToolResponse error.
 */
export function isBridgeResolved(result: BridgeResolution | ToolResponse): result is BridgeResolution {
  return 'bridge' in result;
}
