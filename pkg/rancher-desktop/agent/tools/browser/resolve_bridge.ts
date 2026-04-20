/**
 * resolve_bridge.ts
 *
 * Shared helper for all playwright tools. Resolves a bridge from the
 * main-process proxy by assetId — with fuzzy matching when an exact
 * match isn't found. Never silently returns a different tab's content.
 *
 * The bridge itself handles readiness via its internal state machine
 * (DETACHED → ATTACHED → INJECTING → READY). Commands auto-wait for
 * READY, so resolveBridge just needs to find the right bridge.
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

  if (id === q) return 100;
  if (id.includes(q)) return 80;
  if (q.includes(id)) return 70;
  if (url.includes(q)) return 60;
  if (title.includes(q)) return 50;

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
 * The returned bridge's commands auto-wait for the READY state via
 * the state machine in WebviewHostBridge — no manual waiting needed.
 *
 * When assetId is provided:
 *   1. Exact match → return it
 *   2. No exact match → fuzzy search by ID, title, URL
 *   3. Single close match → return it
 *   4. Multiple close matches → return an error listing them
 *   5. No matches at all → return error with all available assets
 *
 * When assetId is omitted → returns the currently active asset.
 */
export async function resolveBridge(assetId?: string): Promise<BridgeResolution | ToolResponse> {
  const allAssets = await hostBridgeProxy.getAllAssetInfo();

  if (allAssets.length === 0) {
    return {
      successBoolean: false,
      responseString: 'No browser tabs open. Open one first with browser_tab(action: "upsert", assetType: "browser", url: "...").',
    };
  }

  // No assetId provided — use the active asset or the only open one
  if (!assetId?.trim()) {
    const activeId = await hostBridgeProxy.getActiveAssetId();
    const active = activeId ? allAssets.find(a => a.assetId === activeId) : null;

    if (active) {
      return { bridge: hostBridgeProxy.resolve(active.assetId), assetId: active.assetId };
    }

    if (allAssets.length === 1) {
      return { bridge: hostBridgeProxy.resolve(allAssets[0].assetId), assetId: allAssets[0].assetId };
    }

    const list = allAssets.map(formatAssetLine).join('\n');
    return {
      successBoolean: false,
      responseString: `Multiple tabs are open. Specify which one with the assetId parameter:\n${ list }`,
    };
  }

  // assetId provided — try to match
  const query = assetId.trim();

  // 1. Exact match
  const exact = allAssets.find(a => a.assetId === query);
  if (exact) {
    return { bridge: hostBridgeProxy.resolve(exact.assetId), assetId: exact.assetId };
  }

  // 2. Fuzzy match
  const scored = allAssets
    .map(a => ({ asset: a, score: matchScore(query, a) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 1 || (scored.length > 1 && scored[0].score >= 60 && scored[0].score > scored[1].score + 20)) {
    const best = scored[0].asset;
    return { bridge: hostBridgeProxy.resolve(best.assetId), assetId: best.assetId };
  }

  if (scored.length > 1) {
    const list = scored.slice(0, 5).map(s => `${ formatAssetLine(s.asset) } (match: ${ s.score }%)`).join('\n');
    return {
      successBoolean: false,
      responseString: `Asset "${ query }" not found. Multiple close matches — did you mean one of these?\n${ list }`,
    };
  }

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
