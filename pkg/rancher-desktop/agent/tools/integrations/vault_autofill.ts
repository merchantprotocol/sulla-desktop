import { BaseTool, ToolResponse } from '../base';
import { getIntegrationService } from '../../services/IntegrationService';

/**
 * Vault Autofill Tool — triggers autofill on a browser tab login form.
 * The password flows directly from the vault to the browser tab via the main
 * process — it NEVER appears in the LLM context or tool response.
 */
export class VaultAutofillWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { origin, account_id } = input;

    try {
      const service = getIntegrationService();
      await service.initialize();

      // Find matching account
      let targetAccountId = account_id;

      if (!targetAccountId && origin) {
        // Find account by origin
        const accounts = await service.getAccounts('website');
        for (const acct of accounts) {
          const urlValue = await service.getIntegrationValue('website', 'website_url', acct.account_id);
          if (!urlValue?.value) continue;
          try {
            const savedOrigin = new URL(urlValue.value).origin;
            if (savedOrigin === origin) {
              targetAccountId = acct.account_id;
              break;
            }
          } catch { /* invalid URL */ }
        }
      }

      if (!targetAccountId) {
        return {
          successBoolean: false,
          responseString: `No saved credentials found for ${ origin || 'the specified account' }.`,
        };
      }

      // Check LLM access level
      const llmAccessValue = await service.getIntegrationValue('website', 'llm_access', targetAccountId);
      const llmAccess = llmAccessValue?.value || 'none';

      if (llmAccess === 'none' || llmAccess === 'metadata') {
        return {
          successBoolean: false,
          responseString: `Vault access denied. AI access for this credential is set to "${ llmAccess }". The user must grant "autofill" or "full" access to allow AI-initiated autofill.`,
        };
      }

      // Trigger autofill via IPC — the main process handles decryption and
      // direct injection into the browser tab. Password never enters this response.
      try {
        const { ipcRenderer } = require('electron');
        await ipcRenderer.invoke('vault:autofill', {
          accountId: targetAccountId,
        });
      } catch (ipcError) {
        return {
          successBoolean: false,
          responseString: `Autofill IPC failed: ${ ipcError instanceof Error ? ipcError.message : 'Unknown error' }. Make sure a browser tab is open to the target website.`,
        };
      }

      const usernameValue = await service.getIntegrationValue('website', 'username', targetAccountId);
      return {
        successBoolean: true,
        responseString: `Autofill triggered for ${ usernameValue?.value || targetAccountId }. The password was filled directly in the browser — it was not included in this response.`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Vault autofill error: ${ error instanceof Error ? error.message : 'Unknown error' }`,
      };
    }
  }
}
