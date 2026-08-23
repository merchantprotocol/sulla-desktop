import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';
import { isBridgeResolved, resolveBridge } from '../browser/resolve_bridge';

interface AutofillResult {
  success:      boolean;
  runtimeReady: boolean;
  usernameOk:   boolean;
  passwordOk:   boolean;
  error?:       string;
}

/**
 * Build the page-side autofill operation. Only booleans cross back into the
 * tool response; credential values remain inside the page execution call.
 */
export function buildAutofillScript(username: string, password: string): string {
  return `
    (async function() {
      var b = window.sullaBridge;
      if (!b || typeof b.detectLoginForm !== 'function' || typeof b.setValue !== 'function') {
        return {
          success: false,
          runtimeReady: false,
          usernameOk: false,
          passwordOk: false,
          error: 'Browser runtime is not loaded',
        };
      }

      var f = b.detectLoginForm();
      if (!f || !f.hasLoginForm) {
        return {
          success: false,
          runtimeReady: true,
          usernameOk: false,
          passwordOk: false,
          error: 'No login form found',
        };
      }

      var usernameExpected = ${ JSON.stringify(Boolean(username)) };
      var passwordExpected = ${ JSON.stringify(Boolean(password)) };
      var usernameSet = !usernameExpected;
      var passwordSet = !passwordExpected;

      if (usernameExpected && f.usernameHandle) {
        usernameSet = b.setValue(f.usernameHandle, ${ JSON.stringify(username) });
      }
      if (passwordExpected && f.passwordHandle) {
        passwordSet = b.setValue(f.passwordHandle, ${ JSON.stringify(password) });
      }

      // Give synchronous input/change handlers and one microtask a chance to
      // reject or clear the assignment before claiming success.
      await Promise.resolve();

      var usernameOk = !usernameExpected || (
        usernameSet && f.usernameField && String(f.usernameField.value || '').length > 0
      );
      var passwordOk = !passwordExpected || (
        passwordSet && f.passwordField && String(f.passwordField.value || '').length > 0
      );
      var success = Boolean(usernameOk && passwordOk);

      if (!success) {
        var failed = [];
        if (!usernameOk) failed.push('username');
        if (!passwordOk) failed.push('password');
        return {
          success: false,
          runtimeReady: true,
          usernameOk: Boolean(usernameOk),
          passwordOk: Boolean(passwordOk),
          error: 'The page did not retain non-empty ' + failed.join(' and ') + ' field values',
        };
      }

      // Preserve the existing autofill contract: submit only after both
      // expected fields have been proven non-empty.
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

      return {
        success: true,
        runtimeReady: true,
        usernameOk: Boolean(usernameOk),
        passwordOk: Boolean(passwordOk),
      };
    })();
  `;
}

/**
 * Vault Autofill Tool — fills a login form in the active browser tab, or in
 * an explicitly requested background tab. Passwords never enter the tool
 * response or LLM context.
 */
export class VaultAutofillWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { origin, assetId } = input;

    try {
      const service = getIntegrationService();
      await service.initialize();

      let targetAccountId = input['account_id'];
      let credentialOrigin: string | undefined;

      if (!targetAccountId && origin) {
        const accounts = await service.getAccounts('website');
        for (const acct of accounts) {
          const savedAccountId = acct['account_id'];
          const urlValue = await service.getIntegrationValue('website', 'website_url', savedAccountId);
          if (!urlValue?.value) continue;
          try {
            const savedOrigin = new URL(urlValue.value).origin;
            if (savedOrigin === origin) {
              targetAccountId = savedAccountId;
              credentialOrigin = savedOrigin;
              break;
            }
          } catch { /* invalid saved URL */ }
        }
      }

      if (!targetAccountId) {
        return {
          successBoolean: false,
          responseString: `No saved credentials found for ${ origin || 'the specified account' }.`,
        };
      }

      if (!credentialOrigin) {
        const urlValue = await service.getIntegrationValue('website', 'website_url', targetAccountId);
        if (urlValue?.value) {
          try { credentialOrigin = new URL(urlValue.value).origin } catch { /* invalid saved URL */ }
        }
      }

      if (origin && credentialOrigin && origin !== credentialOrigin) {
        return {
          successBoolean: false,
          responseString: `Credential origin ${ credentialOrigin } does not match requested origin ${ origin }.`,
        };
      }

      const llmAccessValue = await service.getIntegrationValue('website', 'llm_access', targetAccountId);
      const llmAccess = llmAccessValue?.value || 'autofill';

      if (llmAccess === 'none' || llmAccess === 'metadata') {
        return {
          successBoolean: false,
          responseString: `Vault access denied. AI access for this credential is set to "${ llmAccess }". The user must grant "autofill" or "full" access to allow AI-initiated autofill.`,
        };
      }

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

      const resolution = await resolveBridge(assetId);
      if (!isBridgeResolved(resolution)) return resolution;

      let targetUrl: string;
      try {
        targetUrl = await resolution.bridge.getPageUrl();
      } catch (err) {
        return {
          successBoolean: false,
          responseString: `[${ resolution.assetId }] Could not inspect the target tab URL: ${ err instanceof Error ? err.message : 'Unknown error' }`,
        };
      }

      let targetOrigin: string;
      try {
        targetOrigin = new URL(targetUrl).origin;
      } catch {
        return {
          successBoolean: false,
          responseString: `[${ resolution.assetId }] Target tab has an invalid URL (${ targetUrl || 'empty' }); credentials were not filled.`,
        };
      }

      const expectedOrigin = origin || credentialOrigin;
      if (expectedOrigin && targetOrigin !== expectedOrigin) {
        return {
          successBoolean: false,
          responseString: `[${ resolution.assetId }] Target tab origin ${ targetOrigin } does not match credential origin ${ expectedOrigin }; credentials were not filled.`,
        };
      }

      let fillResult: AutofillResult;
      try {
        fillResult = await resolution.bridge.execInPageStrict(buildAutofillScript(username, password)) as AutofillResult;
      } catch (err) {
        return {
          successBoolean: false,
          responseString: `[${ resolution.assetId }] Autofill injection failed: ${ err instanceof Error ? err.message : 'Unknown error' }`,
        };
      }

      if (!fillResult || typeof fillResult !== 'object') {
        return {
          successBoolean: false,
          responseString: `[${ resolution.assetId }] Autofill returned no verification result; credentials were not confirmed in the target tab.`,
        };
      }

      const verified = fillResult.success === true &&
        fillResult.runtimeReady === true &&
        (!username || fillResult.usernameOk === true) &&
        (!password || fillResult.passwordOk === true);

      if (!verified) {
        const reason = fillResult.error || 'the page did not confirm the expected fields';
        return {
          successBoolean: false,
          responseString: `[${ resolution.assetId }] Autofill failed for ${ targetOrigin }: ${ reason }.`,
        };
      }

      return {
        successBoolean: true,
        responseString: `[${ resolution.assetId }] Autofill verified non-empty credential fields for ${ targetOrigin }. The password was not included in this response.`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Vault autofill error: ${ error instanceof Error ? error.message : 'Unknown error' }`,
      };
    }
  }
}
