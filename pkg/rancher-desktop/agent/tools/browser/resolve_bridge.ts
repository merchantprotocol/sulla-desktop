// resolve_bridge.ts — Find a tab by assetId (exact or fuzzy) and return a
// GuestBridge for it. Same shape as before; just reads from the main-process
// TabRegistry instead of going through an IPC proxy.

import { tabRegistry } from '@pkg/main/browserTabs/TabRegistry';

import type { GuestBridge } from '@pkg/main/browserTabs/GuestBridge';
import type { TabRecord } from '@pkg/main/browserTabs/TabRegistry';
import type { ToolResponse } from '../base';

export interface BridgeResolution {
  bridge:  GuestBridge;
  assetId: string;
}

function matchScore(query: string, tab: TabRecord): number {
  const q = query.toLowerCase();
  const id = (tab.assetId || '').toLowerCase();
  const title = (tab.title || '').toLowerCase();
  const url = (tab.url || '').toLowerCase();

  if (id === q) return 100;
  if (id.includes(q)) return 80;
  if (q.includes(id)) return 70;
  if (url.includes(q)) return 60;
  if (title.includes(q)) return 50;

  const qTokens = q.split(/[-_\s./]+/).filter(Boolean);
  const targetTokens = [
    ...id.split(/[-_\s./]+/).filter(Boolean),
    ...title.split(/[-_\s./]+/).filter(Boolean),
  ];
  let hits = 0;
  for (const qt of qTokens) {
    if (targetTokens.some(t => t.includes(qt) || qt.includes(t))) hits++;
  }
  if (hits > 0 && qTokens.length > 0) {
    return 20 + Math.round((hits / qTokens.length) * 20);
  }
  return 0;
}

function formatTabLine(t: TabRecord): string {
  return `  - \`${ t.assetId }\` "${ t.title }" (${ t.url })`;
}

export async function resolveBridge(assetId?: string): Promise<BridgeResolution | ToolResponse> {
  const all = tabRegistry.list();

  if (all.length === 0) {
    return {
      successBoolean: false,
      responseString: 'No browser tabs open. Open one first with browser_tab(action: "upsert", assetType: "browser", url: "...").',
    };
  }

  const requireBridge = (assetId: string): BridgeResolution | ToolResponse => {
    const bridge = tabRegistry.bridge(assetId);
    if (!bridge) {
      return { successBoolean: false, responseString: `Tab "${ assetId }" exists in registry but its web view is gone. Reopen the tab.` };
    }
    return { bridge, assetId };
  };

  // No assetId provided — use the active tab, or the only open one.
  if (!assetId?.trim()) {
    const activeId = tabRegistry.getActiveAssetId();
    if (activeId && all.some(t => t.assetId === activeId)) return requireBridge(activeId);
    if (all.length === 1) return requireBridge(all[0].assetId);

    const list = all.map(formatTabLine).join('\n');
    return {
      successBoolean: false,
      responseString: `Multiple tabs are open. Specify which one with the assetId parameter:\n${ list }`,
    };
  }

  const query = assetId.trim();

  // Exact match.
  const exact = all.find(t => t.assetId === query);
  if (exact) return requireBridge(exact.assetId);

  // Fuzzy match.
  const scored = all
    .map(t => ({ tab: t, score: matchScore(query, t) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 1 || (scored.length > 1 && scored[0].score >= 60 && scored[0].score > scored[1].score + 20)) {
    return requireBridge(scored[0].tab.assetId);
  }

  if (scored.length > 1) {
    const list = scored.slice(0, 5).map(s => `${ formatTabLine(s.tab) } (match: ${ s.score }%)`).join('\n');
    return {
      successBoolean: false,
      responseString: `Asset "${ query }" not found. Multiple close matches — did you mean one of these?\n${ list }`,
    };
  }

  const available = all.map(formatTabLine).join('\n');
  return {
    successBoolean: false,
    responseString: `Asset "${ query }" not found.\n\nAvailable tabs:\n${ available }`,
  };
}

export function isBridgeResolved(result: BridgeResolution | ToolResponse): result is BridgeResolution {
  return 'bridge' in result;
}
