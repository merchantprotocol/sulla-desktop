import { requireConfiguredCredentialBroker } from '../../../vault-broker';
import { BaseTool, type ToolResponse } from '../base';
import { scopeItemExecutionContext } from '../credentialScope';

export class VaultRequestWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: Record<string, unknown>): Promise<ToolResponse> {
    if (!this.executionContext) throw new Error('Vault item tools require a verified execution context');
    const context = await scopeItemExecutionContext(this.executionContext, String(input.item));
    const broker = requireConfiguredCredentialBroker();
    const headers = (input.headers ?? {}) as Record<string, string>;
    if (Object.values(headers).some(value => typeof value !== 'string')) throw new Error('Headers must contain string values');
    const result = await broker.execute(broker.requestFor(context, {
      operation: 'item.http', ref: { itemId: context.credential_scope!.item_id },
      url: String(input.url), method: String(input.method), headers, body: input.body,
      injections: [], responseType: 'json',
    }));
    return { successBoolean: true, responseString: JSON.stringify(result) };
  }
}
