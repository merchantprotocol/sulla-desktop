import { BaseTool, ToolResponse } from '../base';
import { getWebSocketClientService } from '../../services/WebSocketClientService';

export class BrowserTabWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const action = String(input.action || 'upsert').trim().toLowerCase();
    const assetType = String(input.assetType || '').trim().toLowerCase();
    const skillSlug = typeof input.skillSlug === 'string' ? input.skillSlug.trim() : '';
    const wsChannel = 'sulla-desktop';

    const wsService = getWebSocketClientService();

    if (action === 'remove') {
      const removeId = typeof input.assetId === 'string' ? input.assetId.trim() : '';
      if (!removeId) {
        return {
          successBoolean: false,
          responseString: 'assetId is required when action is remove.',
        };
      }

      await wsService.send(wsChannel, {
        type:      'deactivate_asset',
        data:      { assetId: removeId },
        timestamp: Date.now(),
      });

      return {
        successBoolean: true,
        responseString: `Removed active asset ${ removeId }`,
      };
    }

    if (assetType !== 'iframe' && assetType !== 'document') {
      return {
        successBoolean: false,
        responseString: 'assetType must be either iframe or document.',
      };
    }

    const assetId = typeof input.assetId === 'string' && input.assetId.trim().length > 0
      ? input.assetId.trim()
      : `${ assetType }_${ Date.now() }`;

    const active = input.active !== false;
    const collapsed = input.collapsed !== false;
    const refKey = typeof input.refKey === 'string' ? input.refKey : undefined;
    const title = typeof input.title === 'string' && input.title.trim().length > 0
      ? input.title.trim()
      : (assetType === 'iframe' ? 'Website' : 'Document');

    if (assetType === 'iframe') {
      const url = typeof input.url === 'string' ? input.url.trim() : '';
      if (!url) {
        return {
          successBoolean: false,
          responseString: 'url is required for iframe assets.',
        };
      }

      await wsService.send(wsChannel, {
        type:      'register_or_activate_asset',
        data:      {
          asset: {
            type: 'iframe',
            id:   assetId,
            title,
            url,
            active,
            collapsed,
            skillSlug: skillSlug || undefined,
            refKey,
          },
        },
        timestamp: Date.now(),
      });

      return {
        successBoolean: true,
        responseString: `Upserted iframe active asset id=${ assetId } url=${ url }. The page is loading in a browser tab. Use get_page_snapshot(assetId='${ assetId }') to see the page content.`,
      };
    }

    const content = typeof input.content === 'string' ? input.content : '';

    await wsService.send(wsChannel, {
      type:      'register_or_activate_asset',
      data:      {
        asset: {
          type: 'document',
          id:   assetId,
          title,
          content,
          active,
          collapsed,
          skillSlug: skillSlug || undefined,
          refKey,
        },
      },
      timestamp: Date.now(),
    });

    return {
      successBoolean: true,
      responseString: `Upserted document active asset id=${ assetId } contentLength=${ content.length }`,
    };
  }
}
