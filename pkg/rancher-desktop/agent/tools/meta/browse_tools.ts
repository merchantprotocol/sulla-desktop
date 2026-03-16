import { BaseTool, ToolResponse, ToolOperation } from '../base';
import { toolRegistry } from '../registry';

/**
 * Browse Tools Tool - Worker class for execution
 */
export class BrowseToolsWorker extends BaseTool {
  name = '';
  description = '';

  private getToolSignature(tool: any): any {
    try {
      return tool?.jsonSchema ?? tool?.schemaDef ?? null;
    } catch {
      return tool?.schemaDef ?? null;
    }
  }

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { category, query, operationType, operationTypes } = input;
    let availableCategories = toolRegistry.getCategories();
    const agentTools = (this.state?.metadata)?.agent?.tools;
    if (Array.isArray(agentTools) && agentTools.length > 0) {
      const allowSet = new Set(agentTools);
      // Keep only categories that have at least one allowed tool
      availableCategories = availableCategories.filter(cat => {
        if (cat === 'meta') return true;
        const toolsInCat = toolRegistry.getToolNamesForCategory(cat);
        return toolsInCat.some(name => allowSet.has(name));
      });
    }
    // Check n8n integration status once for both category and tool filtering
    const n8nEnabled = await this.isN8nIntegrationEnabled();

    // Hide n8n category when n8n integration is not connected
    if (!n8nEnabled) {
      availableCategories = availableCategories.filter(cat => cat !== 'n8n');
    }

    const requestedOperationTypes = this.normalizeOperationTypes(operationType, operationTypes);

    if (category && !availableCategories.includes(category)) {
      return {
        successBoolean: false,
        responseString: `Invalid value for category: must be one of ${ availableCategories.join(', ') }`,
      };
    }

    const tools = await toolRegistry.searchTools(query, category);
    const accessPolicy = (this.state?.metadata)?.__toolAccessPolicy || {};
    const allowedCategories = Array.isArray(accessPolicy.allowedCategories) ? new Set(accessPolicy.allowedCategories) : null;
    const allowedToolNames = Array.isArray(accessPolicy.allowedToolNames) ? new Set(accessPolicy.allowedToolNames) : null;

    // Block browser/playwright tools when caller has no visible browser
    const noBrowser = (this.state?.metadata)?.userVisibleBrowser === false;
    const browserTools = noBrowser
      ? new Set([
        'browser_tab', 'click_element', 'get_form_values',
        'get_page_snapshot', 'get_page_text', 'scroll_to_element',
        'set_field', 'wait_for_element',
      ])
      : null;

    // Block n8n tools when n8n integration is not connected
    const n8nToolNames = !n8nEnabled ? new Set(toolRegistry.getToolNamesForCategory('n8n')) : null;

    const filteredTools = tools.filter((tool: any) => {
      if (browserTools && browserTools.has(tool.name)) {
        return false;
      }

      if (n8nToolNames && n8nToolNames.has(tool.name)) {
        return false;
      }

      if (allowedCategories && !allowedCategories.has(tool.metadata?.category || tool.category)) {
        return false;
      }

      if (allowedToolNames && !allowedToolNames.has(tool.name)) {
        return false;
      }

      if (requestedOperationTypes.length > 0) {
        const toolOperationTypes = this.normalizeOperationTypes(undefined, tool?.metadata?.operationTypes);
        if (!toolOperationTypes.some((type) => requestedOperationTypes.includes(type))) {
          return false;
        }
      }

      return true;
    });

    if (filteredTools.length === 0) {
      return {
        successBoolean: false,
        responseString: `No tools found${ category ? ` in category "${ category }"` : '' }${ query ? ` matching "${ query }"` : '' }${ requestedOperationTypes.length ? ` for operation type(s) "${ requestedOperationTypes.join(', ') }"` : '' }.\n\nAvailable categories: ${ toolRegistry.getCategories().join(', ') }`,
      };
    }

    // Deterministic asset activation: when n8n tools are browsed, activate the n8n asset
    if (category === 'n8n' && this.state && filteredTools.length > 0) {
      this.activateN8nAsset();
    }

    // Attach found tools to state for LLM access
    if (this.state) {
      // Accumulate found tools (append to existing)
      const existingFoundTools = (this.state).foundTools || [];
      (this.state).foundTools = [...existingFoundTools, ...filteredTools];

      // Accumulate LLM tools: ensure meta tools are included + append new found tools (avoid duplicates)
      const existingLLMTools = (this.state).llmTools || [];
      const metaTools = await toolRegistry.getLLMToolsForCategory('meta')();
      const newLLMTools = await Promise.all(filteredTools.map(tool => toolRegistry.convertToolToLLM(tool.name)));

      // Combine all tools, avoiding duplicates by function name
      const allTools = [...metaTools, ...existingLLMTools, ...newLLMTools];
      const uniqueTools = allTools.filter((tool, index, arr) =>
        arr.findIndex(t => t.function?.name === tool.function?.name) === index,
      );

      (this.state).llmTools = uniqueTools;
    }

    const toolDetails = filteredTools.map((tool: any) => ({
      name:        tool.name,
      description: tool.description,
      category:    tool.metadata?.category || tool.category,
      signature:   this.getToolSignature(tool),
    }));

    return {
      successBoolean: true,
      responseString: `Found ${ filteredTools.length } tools${ category ? ` in category "${ category }"` : '' }${ query ? ` matching "${ query }"` : '' }${ requestedOperationTypes.length ? ` for operation type(s) "${ requestedOperationTypes.join(', ') }"` : '' }.
${ JSON.stringify(toolDetails, null, 2) }`,
    };
  }

  private activateN8nAsset(): void {
    const stateAny = this.state;
    if (!stateAny || stateAny.metadata?.__n8nAssetActivated) {
      return;
    }

    // Fire-and-forget: start the n8n stream via the node that's executing us.
    // The node injects itself as __executingNode on the state before tool invocation
    // isn't available, so we dispatch the WS message directly instead.
    (async() => {
      try {
        const { getN8nBridgeService } = await import('../../services/N8nBridgeService');
        const bridge = getN8nBridgeService();
        await bridge.start();

        stateAny.metadata.__n8nAssetActivated = true;

        const wsChannel = String(stateAny.metadata?.wsChannel || 'sulla-desktop');
        const selectedSkillSlug = String(stateAny.metadata?.planRetrieval?.selected_skill_slug || '');
        const n8nRootUrl = String(bridge.getAppRootUrl() || 'http://127.0.0.1:30119/').trim();

        const { getWebSocketClientService } = await import('../../services/WebSocketClientService');
        const wsService = getWebSocketClientService();
        await wsService.send(wsChannel, {
          type: 'register_or_activate_asset',
          data: {
            asset: {
              type:      'iframe',
              id:        'n8n',
              title:     'n8n Workflows',
              url:       n8nRootUrl,
              active:    true,
              collapsed: true,
              skillSlug: selectedSkillSlug,
            },
          },
          timestamp: Date.now(),
        });

        console.log('[BrowseTools] n8n asset activated via browse_tools category lookup');
      } catch (error) {
        console.warn('[BrowseTools] Failed to activate n8n asset:', error);
      }
    })();
  }

  private async isN8nIntegrationEnabled(): Promise<boolean> {
    try {
      const { getIntegrationService } = await import('../../services/IntegrationService');
      return await getIntegrationService().isAnyAccountConnected('n8n');
    } catch {
      return false;
    }
  }

  private normalizeOperationTypes(single?: unknown, many?: unknown): ToolOperation[] {
    const allowed: ToolOperation[] = ['read', 'create', 'update', 'delete', 'execute'];
    const set = new Set<ToolOperation>();

    const normalize = (value: unknown): ToolOperation | null => {
      const normalized = String(value || '').trim().toLowerCase();
      return (allowed as string[]).includes(normalized) ? normalized as ToolOperation : null;
    };

    const singleNormalized = normalize(single);
    if (singleNormalized) {
      set.add(singleNormalized);
    }

    if (Array.isArray(many)) {
      for (const value of many) {
        const normalized = normalize(value);
        if (normalized) {
          set.add(normalized);
        }
      }
    }

    return Array.from(set);
  }
}
