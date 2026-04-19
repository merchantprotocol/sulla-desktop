import { integrations } from '../../integrations/catalog';
import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

import { getExtensionService } from '@pkg/agent/services/ExtensionService';

/**
 * Integration Get Credentials Tool - Worker class for execution
 * Returns credentials for ALL accounts of a given integration.
 * The default account is marked with ★ DEFAULT.
 */
export class IntegrationGetCredentialsWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { account_type, include_secrets } = input;

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

      // List all accounts for this integration
      const accounts = await service.getAccounts(account_type);
      const catalogProperties = catalogEntry.properties ?? [];
      const secretKeys = new Set(catalogProperties.filter(p => p.type === 'password').map(p => p.key));

      let responseString = `Integration: ${ account_type } (${ catalogEntry.name })\n`;

      if (accounts.length === 0) {
        responseString += `No accounts configured.\n\nExpected credentials:\n`;
        catalogProperties.forEach(prop => {
          responseString += `- ${ prop.title } (${ prop.key }): [NOT SET] (${ prop.required ? 'Required' : 'Optional' })\n`;
        });

        return {
          successBoolean: true,
          responseString,
        };
      }

      responseString += `Accounts: ${ accounts.length }\n\n`;

      for (const acct of accounts) {
        const status = await service.getConnectionStatus(account_type, acct.account_id);
        const formValues = await service.getFormValues(account_type, acct.account_id);

        // Build a map of property key -> stored value
        const storedValues: Record<string, string> = {};
        for (const fv of formValues) {
          storedValues[fv.property] = fv.value;
        }

        // Check LLM access level for this account
        const llmAccess = storedValues['llm_access'] || 'autofill';

        // If access is 'none', skip this account entirely
        if (llmAccess === 'none') {
          const defaultMarker = acct.active ? ' ★ DEFAULT' : '';
          responseString += `--- Account: ${ acct.label } (${ acct.account_id })${ defaultMarker } ---\n`;
          responseString += `[VAULT PROTECTED] — AI access is set to "none" for this account.\n\n`;
          continue;
        }

        const defaultMarker = acct.active ? ' ★ DEFAULT' : '';
        responseString += `--- Account: ${ acct.label } (${ acct.account_id })${ defaultMarker } ---\n`;
        responseString += `Enabled: ${ status.connected ? 'Yes' : 'No' }\n`;
        responseString += `Connected at: ${ status.connected_at ? new Date(status.connected_at).toLocaleString() : 'Never' }\n`;
        responseString += `Last sync at: ${ status.last_sync_at ? new Date(status.last_sync_at).toLocaleString() : 'Never' }\n`;
        responseString += `AI Access: ${ llmAccess }\n`;
        responseString += `Credentials:\n`;

        catalogProperties.forEach(prop => {
          // Skip llm_access from display — it's shown in the header above
          if (prop.key === 'llm_access') return;

          const hasValue = prop.key in storedValues;
          let displayValue = '[NOT SET]';
          if (hasValue) {
            const raw = String(storedValues[prop.key]);

            // Apply LLM access restrictions
            if (llmAccess === 'metadata') {
              // Metadata-only: show non-secret fields, mask secrets
              if (secretKeys.has(prop.key)) {
                displayValue = '[VAULT PROTECTED]';
              } else {
                displayValue = raw;
              }
            } else if (llmAccess === 'autofill') {
              // Autofill: same as metadata — agent can trigger autofill but not see passwords
              if (secretKeys.has(prop.key)) {
                displayValue = '[VAULT PROTECTED — use vault/autofill tool to fill this]';
              } else {
                displayValue = raw;
              }
            } else if (secretKeys.has(prop.key) && !include_secrets) {
              // Full access with secrets masked by default
              displayValue = raw.length > 4 ? '****' + raw.slice(-4) : '****';
            } else {
              displayValue = raw;
            }
          }
          responseString += `- ${ prop.title } (${ prop.key }): ${ displayValue } (${ prop.required ? 'Required' : 'Optional' })\n`;
        });

        responseString += `\n`;
      }

      responseString += `Use vault/set_active_account to change which account is the default.`;

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      if (error instanceof Error) {
        return {
          successBoolean: false,
          responseString: `Error retrieving integration credentials: ${ error.message }`,
        };
      } else {
        return {
          successBoolean: false,
          responseString: 'Error retrieving integration credentials: Unknown error',
        };
      }
    }
  }
}
