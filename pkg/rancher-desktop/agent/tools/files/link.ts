import { FilesTool, filesService } from './common';

import { getCurrentAccessToken } from '@pkg/main/sullaCloudAuth';

import type { ToolResponse } from '../base';

export class FilesLinkWorker extends FilesTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const context = this.context(input);
    if (input.target_file_id && input.kind) {
      await filesService().link(context, input.file_id, input.target_file_id, input.kind);
      return { successBoolean: true, responseString: 'File link saved.' };
    }

    const token = await getCurrentAccessToken();
    if (!token) return { successBoolean: false, responseString: 'Sign in to Sulla Cloud before creating a public share link.' };
    const assetKind = input.asset_kind === 'capture' ? 'capture' : input.asset_kind === 'artifact' ? 'artifact' : 'file';
    const keepAvailable = typeof input.keep_available === 'boolean' ? input.keep_available : assetKind === 'capture';
    const expiresAt = input.expires_at ? new Date(input.expires_at) : undefined;
    if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) {
      return { successBoolean: false, responseString: 'expires_at must be a future ISO timestamp.' };
    }
    try {
      const response = await this.containerRequest('/v1/links', input, {
        method:  'POST',
        headers: { 'X-Sulla-Cloud-Token': token },
        body:    JSON.stringify({
          fileId:          input.file_id,
          collectionId:    input.collection_id,
          folderPath:      input.folder_path,
          permission:      input.access_mode,
          password:        input.password,
          expiresAt:       expiresAt?.toISOString(),
          keepAvailable,
          assetKind,
          captureMetadata: input.capture_metadata,
        }),
      });
      const share = await response.json() as { public_url?: string };
      return { successBoolean: true, responseString: `Share link created: ${ share.public_url }`, share } as any;
    } catch (error) {
      return { successBoolean: false, responseString: `Share link registration failed: ${ error instanceof Error ? error.message : String(error) }` };
    }
  }
}
