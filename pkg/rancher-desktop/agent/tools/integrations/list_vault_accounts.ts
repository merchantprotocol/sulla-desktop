import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

/**
 * List Integration Accounts Tool
 * Lists all accounts for a given integration, showing which one is active.
 * The LLM can then use vault/set_active_account to switch accounts.
 */
export class ListIntegrationAccountsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { account_type } = input;

    if (!account_type) {
      return {
        successBoolean: false,
        responseString: 'account_type is required.',
      };
    }

    try {
      const service = getIntegrationService();
      await service.initialize();

      const accounts = await service.getAccounts(account_type);

      if (accounts.length === 0) {
        return {
          successBoolean: true,
          responseString: `No accounts configured for integration "${ account_type }".`,
        };
      }

      let responseString = `Accounts for "${ account_type }" (${ accounts.length }):\n`;
      for (const acct of accounts) {
        const activeMarker = acct.active ? ' ★ ACTIVE' : '';
        const connStatus = acct.connected ? 'Connected' : 'Disconnected';
        responseString += `- ${ acct.label } (account_id: "${ acct.account_id }") | ${ connStatus }${ activeMarker }\n`;
      }

      responseString += `\nTo switch accounts, use vault/set_active_account with account_type and account_id.`;

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
