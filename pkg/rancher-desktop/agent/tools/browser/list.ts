import { tabRegistry } from '@pkg/main/browserTabs/TabRegistry';

import { BaseTool, ToolResponse } from '../base';

export class ListTabsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    const all = tabRegistry.list();
    const activeId = tabRegistry.getActiveAssetId();

    if (all.length === 0) {
      return { successBoolean: true, responseString: 'No browser tabs open.' };
    }

    const lines: string[] = [`${ all.length } tab(s) open:\n`];
    for (const tab of all) {
      const status = tab.isLoading ? 'loading' : 'ready';
      const active = tab.assetId === activeId ? ' (active)' : '';
      lines.push(`- **${ tab.assetId }**${ active } [${ status }]`);
      lines.push(`  Title: ${ tab.title || '(untitled)' }`);
      lines.push(`  URL: ${ tab.url || '(none)' }`);
    }

    return { successBoolean: true, responseString: lines.join('\n') };
  }
}
