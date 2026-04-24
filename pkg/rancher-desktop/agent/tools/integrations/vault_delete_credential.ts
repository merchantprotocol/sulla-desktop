import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

/**
 * Delete a single credential property from the vault. Destructive — refuses
 * without {"confirm":true}. Local account row + property is removed; other
 * properties on the account (and other accounts on the same integration)
 * are untouched.
 */
export class VaultDeleteCredentialWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const accountType = typeof input.account_type === 'string' ? input.account_type.trim() : '';
    const property    = typeof input.property === 'string' ? input.property.trim() : '';
    const accountId   = typeof input.account_id === 'string' ? input.account_id.trim() : undefined;
    const confirm     = input.confirm === true;

    if (!accountType) {
      return { successBoolean: false, responseString: 'Missing required field: account_type (e.g. "github", "slack").' };
    }
    if (!property) {
      return { successBoolean: false, responseString: 'Missing required field: property (the credential key to delete, e.g. "api_token").' };
    }
    if (!confirm) {
      return {
        successBoolean: false,
        responseString:
          `Refusing to delete ${ accountType }${ accountId ? `/${ accountId }` : '' }.${ property } without explicit ` +
          `confirmation. Re-call with {"confirm":true} if you're sure. This is destructive — anything using this ` +
          `credential will stop working until it's re-entered.`,
      };
    }

    try {
      const svc = getIntegrationService();
      const ok = await svc.deleteIntegrationValue(accountType, property, accountId);
      if (!ok) {
        return {
          successBoolean: false,
          responseString: `No credential found at ${ accountType }${ accountId ? `/${ accountId }` : '' }.${ property } — nothing to delete.`,
        };
      }
      return {
        successBoolean: true,
        responseString: `Deleted ${ accountType }${ accountId ? `/${ accountId }` : '' }.${ property } from the vault. Cached client for this integration is invalidated.`,
      };
    } catch (err) {
      return {
        successBoolean: false,
        responseString: `Delete failed: ${ (err as Error).message }`,
      };
    }
  }
}
