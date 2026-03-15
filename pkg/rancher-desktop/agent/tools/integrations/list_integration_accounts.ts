import { BaseTool, ToolResponse } from '../base';
import { getIntegrationService } from '../../services/IntegrationService';

/**
 * List Integration Accounts Tool
 * Lists all accounts for a given integration, showing which one is active.
 * The LLM can then use set_active_integration_account to switch accounts.
 */
export class ListIntegrationAccountsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { integration_slug } = input;

    if (!integration_slug) {
      return {
        successBoolean: false,
        responseString: 'integration_slug is required.',
      };
    }

    try {
      const service = getIntegrationService();
      await service.initialize();

      const accounts = await service.getAccounts(integration_slug);

      if (accounts.length === 0) {
        return {
          successBoolean: true,
          responseString: `No accounts configured for integration "${ integration_slug }".`,
        };
      }

      let responseString = `Accounts for "${ integration_slug }" (${ accounts.length }):\n`;
      for (const acct of accounts) {
        const activeMarker = acct.active ? ' ★ ACTIVE' : '';
        const connStatus = acct.connected ? 'Connected' : 'Disconnected';
        responseString += `- ${ acct.label } (account_id: "${ acct.account_id }") | ${ connStatus }${ activeMarker }\n`;
      }

      responseString += `\nTo switch accounts, use set_active_integration_account with integration_slug and account_id.`;

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error listing accounts: ${ error instanceof Error ? error.message : 'Unknown error' }`,
      };
    }
  }
}
