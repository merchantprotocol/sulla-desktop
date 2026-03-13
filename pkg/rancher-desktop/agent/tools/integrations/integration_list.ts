import { BaseTool, ToolResponse } from "../base";
import { getIntegrationService } from "../../services/IntegrationService";
import { integrations } from "../../integrations/catalog";
import { getExtensionService } from "@pkg/agent/services/ExtensionService";

/**
 * Integration List Tool - Worker class for execution
 */
export class IntegrationListWorker extends BaseTool {
  name: string = '';
  description: string = '';

  protected async _validatedCall(_input: any): Promise<ToolResponse> {

    try {
      const service = getIntegrationService();
      await service.initialize();

      const extensionService = getExtensionService();
      await extensionService.initialize();

      const extensionIntegrations = extensionService.getExtensionIntegrations();
      const mergedIntegrations = { ...integrations };
      for (const extInt of extensionIntegrations) {
        mergedIntegrations[extInt.id] = extInt;
      }

      // Filter by agent's integrations allowlist
      const agentIntegrations: string[] | undefined = (this.state?.metadata as any)?.agent?.integrations;
      const allowAll = agentIntegrations?.includes('*');
      const hasAllowlist = Array.isArray(agentIntegrations) && agentIntegrations.length > 0;

      const allIntegrations = await Promise.all(
        Object.entries(mergedIntegrations)
          .filter(([slug]) => {
            if (!hasAllowlist) return true;  // no allowlist = show all (backwards compat)
            return allowAll || agentIntegrations!.includes(slug);
          })
          .map(async ([integration_slug, catalogEntry]) => {
            const status = await service.getConnectionStatus(integration_slug);
            return {
              integration_slug,
              name: catalogEntry.name,
              enabled: status.connected,
              connected_at: status.connected_at ? new Date(status.connected_at).toISOString() : null,
              last_sync_at: status.last_sync_at ? new Date(status.last_sync_at).toISOString() : null,
            };
          }),
      );

      const results = allIntegrations;

      if (results.length === 0) {
        return {
          successBoolean: true,
          responseString: 'No integrations found.',
        };
      }

      let responseString = `Integrations (${results.length})\n`;
      results.forEach((integration) => {
        responseString += `- ${integration.integration_slug} (${integration.name}) | Enabled: ${integration.enabled ? 'Yes' : 'No'} | Connected at: ${integration.connected_at || 'Never'} | Last sync at: ${integration.last_sync_at || 'Never'}\n`;
      });

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      if (error instanceof Error) {
        return {
          successBoolean: false,
          responseString: `Error listing integrations: ${error.message}`,
        };
      }

      return {
        successBoolean: false,
        responseString: 'Error listing integrations: Unknown error',
      };
    }
  }
}

