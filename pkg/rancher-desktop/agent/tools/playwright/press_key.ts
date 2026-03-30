import { BaseTool, ToolResponse } from '../base';
import { resolveBridge, isBridgeResolved } from './resolve_bridge';

export class PressKeyWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { key, handle } = input;
    const result = await resolveBridge(input.assetId);
    if (!isBridgeResolved(result)) return result;

    try {
      const success = await result.bridge.pressKey(key, handle);
      if (!success) {
        return {
          successBoolean: false,
          responseString: `[${ result.assetId }] Failed to dispatch key "${ key }"${ handle ? ` on element ${ handle }` : '' }.`,
        };
      }

      return {
        successBoolean: true,
        responseString: `[${ result.assetId }] Pressed "${ key }"${ handle ? ` on ${ handle }` : ' on focused element' }.`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error pressing key: ${ (error as Error).message }`,
      };
    }
  }
}
