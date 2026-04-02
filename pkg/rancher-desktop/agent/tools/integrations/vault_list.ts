import { BaseTool, ToolResponse } from '../base';
import { getIntegrationService } from '../../services/IntegrationService';

/**
 * Vault List Tool — lists saved website credentials, respecting LLM access levels.
 * Passwords are NEVER returned. Only origin, username, and access level.
 */
export class VaultListWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    try {
      const service = getIntegrationService();
      await service.initialize();

      const accounts = await service.getAccounts('website');

      if (accounts.length === 0) {
        return {
          successBoolean: true,
          responseString: 'No saved website credentials found in the vault.',
        };
      }

      let responseString = `Saved website credentials: ${ accounts.length }\n\n`;

      for (const acct of accounts) {
        const formValues = await service.getFormValues('website', acct.account_id);
        const storedValues: Record<string, string> = {};
        for (const fv of formValues) {
          storedValues[fv.property] = fv.value;
        }

        const llmAccess = storedValues['llm_access'] || 'autofill';

        if (llmAccess === 'none') {
          responseString += `- ${ acct.label } (${ acct.account_id }): [VAULT PROTECTED]\n`;
          continue;
        }

        const url = storedValues['website_url'] || 'unknown';
        const username = storedValues['username'] || 'unknown';
        responseString += `- ${ acct.label } (${ acct.account_id }): ${ url } — ${ username } [AI access: ${ llmAccess }]\n`;
      }

      responseString += `\nUse vault/autofill to fill login forms on websites where AI access is "autofill" or "full".`;

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error listing vault credentials: ${ error instanceof Error ? error.message : 'Unknown error' }`,
      };
    }
  }
}
