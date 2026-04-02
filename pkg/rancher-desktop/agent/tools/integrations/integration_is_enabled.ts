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
    const { account_type } = input;

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

      const catalogEntry = mergedIntegrations[account_type];
      if (!catalogEntry) {
        return {
          successBoolean: false,
          responseString: `Integration "${ account_type }" not found in the catalog. Available integrations: ${ Object.keys(mergedIntegrations).join(', ') }`,
        };
      }

      await service.initialize();

      const anyConnected = await service.isAnyAccountConnected(account_type);
      const accounts = await service.getAccounts(account_type);
      const activeAccountId = await service.getActiveAccountId(account_type);
      const status = await service.getConnectionStatus(account_type, activeAccountId);

      let responseString = `Integration: ${ account_type } (${ catalogEntry.name })
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
