import { BaseTool, ToolResponse } from '../base';
import { getIntegrationService } from '../../services/IntegrationService';
import { integrations } from '../../integrations/catalog';
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
    const { integration_slug, include_secrets } = input;

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

      // List all accounts for this integration
      const accounts = await service.getAccounts(integration_slug);
      const catalogProperties = catalogEntry.properties ?? [];
      const secretKeys = new Set(catalogProperties.filter(p => p.type === 'password').map(p => p.key));

      let responseString = `Integration: ${ integration_slug } (${ catalogEntry.name })\n`;

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
        const status = await service.getConnectionStatus(integration_slug, acct.account_id);
        const formValues = await service.getFormValues(integration_slug, acct.account_id);

        // Build a map of property key -> stored value
        const storedValues: Record<string, string> = {};
        for (const fv of formValues) {
          storedValues[fv.property] = fv.value;
        }

        const defaultMarker = acct.active ? ' ★ DEFAULT' : '';
        responseString += `--- Account: ${ acct.label } (${ acct.account_id })${ defaultMarker } ---\n`;
        responseString += `Enabled: ${ status.connected ? 'Yes' : 'No' }\n`;
        responseString += `Connected at: ${ status.connected_at ? new Date(status.connected_at).toLocaleString() : 'Never' }\n`;
        responseString += `Last sync at: ${ status.last_sync_at ? new Date(status.last_sync_at).toLocaleString() : 'Never' }\n`;
        responseString += `Credentials:\n`;

        catalogProperties.forEach(prop => {
          const hasValue = prop.key in storedValues;
          let displayValue = '[NOT SET]';
          if (hasValue) {
            const raw = String(storedValues[prop.key]);
            if (secretKeys.has(prop.key) && !include_secrets) {
              displayValue = raw.length > 4 ? '****' + raw.slice(-4) : '****';
            } else {
              displayValue = raw;
            }
          }
          responseString += `- ${ prop.title } (${ prop.key }): ${ displayValue } (${ prop.required ? 'Required' : 'Optional' })\n`;
        });

        responseString += `\n`;
      }

      responseString += `Use set_active_integration_account to change which account is the default.`;

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
