import { BaseTool, ToolResponse } from '../base';
import { hostBridgeProxy } from '../../scripts/injected/HostBridgeProxy';

/**
 * List Tabs Tool — lists all open browser tabs with their assetId, URL, title, and status.
 */
export class ListTabsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    const allAssets = await hostBridgeProxy.getAllAssetInfo();
    const activeId = await hostBridgeProxy.getActiveAssetId();

    if (allAssets.length === 0) {
      return {
        successBoolean: true,
        responseString: 'No browser tabs open.',
      };
    }

    const lines: string[] = [];
    lines.push(`${ allAssets.length } tab(s) open:\n`);

    for (const asset of allAssets) {
      const status = asset.isInjected ? 'ready' : 'loading';
      const active = asset.assetId === activeId ? ' (active)' : '';
      lines.push(`- **${ asset.assetId }**${ active } [${ status }]`);
      lines.push(`  Title: ${ asset.title || '(untitled)' }`);
      lines.push(`  URL: ${ asset.url || '(none)' }`);
    }

    return {
      successBoolean: true,
      responseString: lines.join('\n'),
    };
  }
}
