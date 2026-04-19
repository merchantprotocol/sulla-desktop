import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

/**
 * Vault Autofill Tool — triggers autofill on a browser tab login form.
 * The password flows directly from the vault to the browser tab via
 * BrowserTabViewManager — it NEVER appears in the LLM context or tool response.
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
      const llmAccess = llmAccessValue?.value || 'autofill';

      if (llmAccess === 'none' || llmAccess === 'metadata') {
        return {
          successBoolean: false,
          responseString: `Vault access denied. AI access for this credential is set to "${ llmAccess }". The user must grant "autofill" or "full" access to allow AI-initiated autofill.`,
        };
      }

      // Get the credentials
      const usernameValue = await service.getIntegrationValue('website', 'username', targetAccountId);
      const passwordValue = await service.getIntegrationValue('website', 'password', targetAccountId);
      const username = usernameValue?.value || '';
      const password = passwordValue?.value || '';

      if (!username && !password) {
        return {
          successBoolean: false,
          responseString: 'Saved credentials are empty for this account.',
        };
      }

      // Use BrowserTabViewManager to inject credentials directly into the active browser tab.
      // This runs in the main process so we can access the tab view manager directly.
      try {
        const { BrowserTabViewManager } = await import('../../../window/browserTabViewManager');
        const tabManager = BrowserTabViewManager.getInstance();

        // Find the active browser tab that matches the origin
        const views = (tabManager as any).views as Map<string, any>;
        let filled = false;

        for (const [tabId, view] of views) {
          const tabUrl = view.webContents.getURL();
          try {
            const tabOrigin = new URL(tabUrl).origin;
            if (origin && tabOrigin !== origin) continue;
          } catch { continue }

          // Inject credentials directly into the tab
          const fillScript = `
            (function() {
              var b = window.sullaBridge;
              if (!b) return { success: false, error: 'Bridge not available' };
              var f = b.detectLoginForm();
              if (!f || !f.hasLoginForm) return { success: false, error: 'No login form found' };
              var uOk = false, pOk = false;
              if (f.usernameHandle) uOk = b.setValue(f.usernameHandle, ${ JSON.stringify(username) });
              if (f.passwordHandle) pOk = b.setValue(f.passwordHandle, ${ JSON.stringify(password) });
              // Auto-submit after filling
              setTimeout(function() {
                var pwEl = f.passwordField;
                var form = pwEl && pwEl.closest ? pwEl.closest('form') : null;
                if (form) {
                  if (typeof form.requestSubmit === 'function') { form.requestSubmit(); }
                  else { form.submit(); }
                } else {
                  var container = pwEl ? pwEl.parentElement : document.body;
                  for (var d = 0; d < 5 && container; d++) {
                    var btn = container.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
                    if (btn) { btn.click(); break; }
                    container = container.parentElement;
                  }
                }
              }, 200);
              return { success: uOk || pOk, usernameOk: uOk, passwordOk: pOk };
            })();
          `;
          await view.webContents.executeJavaScript(fillScript, true);
          filled = true;
          break;
        }

        if (!filled) {
          return {
            successBoolean: false,
            responseString: `No browser tab found${ origin ? ` for ${ origin }` : '' }. Make sure a browser tab is open to the login page.`,
          };
        }
      } catch (err) {
        return {
          successBoolean: false,
          responseString: `Autofill injection failed: ${ err instanceof Error ? err.message : 'Unknown error' }`,
        };
      }

      return {
        successBoolean: true,
        responseString: `Autofill triggered for ${ username }. The password was filled directly in the browser — it was not included in this response.`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Vault autofill error: ${ error instanceof Error ? error.message : 'Unknown error' }`,
      };
    }
  }
}
