import { BaseTool, ToolResponse } from '../base';
import { getIntegrationService } from '../../services/IntegrationService';
import { integrations } from '../../integrations/catalog';
import { getExtensionService } from '@pkg/agent/services/ExtensionService';

/**
 * Integration Is Enabled Tool - Worker class for execution
 */
export class IntegrationIsEnabledWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { integration_slug } = input;

    try {
      const service = getIntegrationService();
      const baseIntegrations = integrations;

      const extensionService = getExtensionService();
      await extensionService.initialize();

      const extensionIntegrations = extensionService.getExtensionIntegrations();
      const mergedIntegrations = { ...baseIntegrations };
      for (const extInt of extensionIntegrations) {
        mergedIntegrations[extInt.id] = extInt;
      }

      const catalogEntry = mergedIntegrations[integration_slug];
      if (!catalogEntry) {
        return {
          successBoolean: false,
          responseString: `Integration "${ integration_slug }" not found in the catalog. Available integrations: ${ Object.keys(mergedIntegrations).join(', ') }`,
        };
      }

      await service.initialize();

      const anyConnected = await service.isAnyAccountConnected(integration_slug);
      const accounts = await service.getAccounts(integration_slug);
      const activeAccountId = await service.getActiveAccountId(integration_slug);
      const status = await service.getConnectionStatus(integration_slug, activeAccountId);

      let responseString = `Integration: ${ integration_slug } (${ catalogEntry.name })
Enabled: ${ anyConnected ? 'Yes' : 'No' }
Active account: ${ activeAccountId }
Connected at: ${ status.connected_at ? new Date(status.connected_at).toLocaleString() : 'Never' }
Last sync at: ${ status.last_sync_at ? new Date(status.last_sync_at).toLocaleString() : 'Never' }`;

      if (accounts.length > 1) {
        responseString += `\n\nAccounts (${ accounts.length }):`;
        for (const acct of accounts) {
          const marker = acct.active ? ' ★ ACTIVE' : '';
          responseString += `\n- ${ acct.label } (${ acct.account_id }) | ${ acct.connected ? 'Connected' : 'Disconnected' }${ marker }`;
        }
      }

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      if (error instanceof Error) {
        return {
          successBoolean: false,
          responseString: `Error checking integration status: ${ error.message }`,
        };
      } else {
        return {
          successBoolean: false,
          responseString: 'Error checking integration status: Unknown error',
        };
      }
    }
  }
}
