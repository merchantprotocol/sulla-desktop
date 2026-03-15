import { BaseTool, ToolResponse } from '../base';
import { getIntegrationService } from '../../services/IntegrationService';

/**
 * Set Active Integration Account Tool
 * Allows the LLM to pick which account to use for a multi-account integration.
 * After setting the active account, all subsequent tool calls for that integration
 * will automatically use the active account's credentials.
 */
export class SetActiveIntegrationAccountWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { integration_slug, account_id } = input;

    if (!integration_slug || !account_id) {
      return {
        successBoolean: false,
        responseString: 'Both integration_slug and account_id are required.',
      };
    }

    try {
      const service = getIntegrationService();
      await service.initialize();

      // Verify the account exists
      const accounts = await service.getAccounts(integration_slug);
      const account = accounts.find(a => a.account_id === account_id);

      if (!account) {
        const available = accounts.map(a => `${ a.account_id } (${ a.label })`).join(', ');
        return {
          successBoolean: false,
          responseString: `Account "${ account_id }" not found for integration "${ integration_slug }". Available accounts: ${ available || 'none' }`,
        };
      }

      await service.setActiveAccount(integration_slug, account_id);

      return {
        successBoolean: true,
        responseString: `Active account for "${ integration_slug }" set to "${ account.label }" (${ account_id }). All subsequent tool calls for this integration will use this account's credentials.`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error setting active account: ${ error instanceof Error ? error.message : 'Unknown error' }`,
      };
    }
  }
}
