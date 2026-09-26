import { integrations } from '../../integrations/catalog';
import { getIntegrationService } from '../../services/IntegrationService';
import { AGENT_PROTECTED_PROPERTIES } from '../../services/vaultAccessPolicy';
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
    const { account_type, property, value, account_id, confirm } = input;

    if (!account_type || !property || value == null) {
      return {
        successBoolean: false,
        responseString: 'account_type, property, and value are all required.',
      };
    }

    if (AGENT_PROTECTED_PROPERTIES.has(String(property).trim())) {
      return {
        successBoolean: false,
        responseString: `"${ property }" controls what the AI may access and can only be changed by the user in the vault UI.`,
      };
    }

    try {
      const service = getIntegrationService();
      await service.initialize();

      // Overwriting a stored secret destroys the only copy the user has.
      const secretKeys = new Set(['password', 'api_key', 'bearer_token', 'access_token', 'refresh_token', 'client_secret', 'token', 'secret']);
      for (const p of integrations[account_type]?.properties ?? []) {
        if (p.type === 'password') secretKeys.add(p.key);
      }
      if (secretKeys.has(property) && confirm !== true) {
        const existing = await service.getIntegrationValue(account_type, property, account_id || undefined);
        if (existing?.value && existing.value !== String(value)) {
          return {
            successBoolean: false,
            responseString: `Refusing to overwrite the existing ${ account_type }${ account_id ? `/${ account_id }` : '' }.${ property } without explicit confirmation. ` +
              'The current value would be replaced. Re-call with {"confirm":true} only if the user asked for this change.',
          };
        }
      }

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
