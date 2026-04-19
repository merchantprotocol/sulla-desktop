import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

/**
 * Set Integration Credential Tool
 * Allows the model to store or update a credential property for an integration account.
 * The value is encrypted and stored in the vault — it never appears in conversation after this call.
 */
export class IntegrationSetCredentialWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { account_type, property, value, account_id } = input;

    if (!account_type || !property || value == null) {
      return {
        successBoolean: false,
        responseString: 'account_type, property, and value are all required.',
      };
    }

    try {
      const service = getIntegrationService();
      await service.initialize();

      await service.setIntegrationValue({
        integration_id: account_type,
        account_id:     account_id || undefined,
        property,
        value:          String(value),
      });

      // Mark the integration as connected if we're setting a credential
      const credentialProperties = ['bearer_token', 'api_key', 'access_token', 'password'];
      if (credentialProperties.includes(property)) {
        await service.setConnectionStatus(account_type, true, account_id || undefined);
      }

      return {
        successBoolean: true,
        responseString: `Credential "${ property }" saved for integration "${ account_type }"${ account_id ? ` (account: ${ account_id })` : '' }. The value is now encrypted in the vault.`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error saving credential: ${ error instanceof Error ? error.message : 'Unknown error' }`,
      };
    }
  }
}
