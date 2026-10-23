import { FilesTool } from './common';

import { getDesktopDeviceId } from '@pkg/main/deviceIdentity';
import { isCloudSignedIn } from '@pkg/main/cloud/cloudFetch';

import type { ToolResponse } from '../base';

export class FilesLinkWorker extends FilesTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const context = this.context(input);
    const resolved = await this.resolvePath(input);
    if (resolved?.kind === 'file') input = { ...input, file_id: resolved.fileId, collection_id: resolved.collectionId };
    else if (resolved?.kind === 'folder') input = { ...input, collection_id: resolved.collectionId, folder_path: resolved.folderPath };
    if (input.target_file_id && input.kind) {
      await this.containerJson('/v1/file-edges', input, { method: 'POST', body: JSON.stringify({ fileId: input.file_id, targetFileId: input.target_file_id, kind: input.kind }) });
      return { successBoolean: true, responseString: 'File link saved.' };
    }

    if (!await isCloudSignedIn()) return { successBoolean: false, responseString: 'Sign in to Sulla Cloud before creating a public share link.' };
    const assetKind = input.asset_kind === 'capture' ? 'capture' : input.asset_kind === 'artifact' ? 'artifact' : 'file';
    const keepAvailable = typeof input.keep_available === 'boolean' ? input.keep_available : assetKind === 'capture';
    const expiresAt = input.expires_at ? new Date(input.expires_at) : undefined;
    if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) {
      return { successBoolean: false, responseString: 'expires_at must be a future ISO timestamp.' };
    }
    try {
      const response = await this.containerRequest('/v1/links', input, {
        method:  'POST',
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
          deviceId:        await getDesktopDeviceId(),
        }),
      });
      const share = await response.json() as { public_url?: string };
      return { successBoolean: true, responseString: `Share link created: ${ share.public_url }`, share } as any;
    } catch (error) {
      return { successBoolean: false, responseString: `Share link registration failed: ${ error instanceof Error ? error.message : String(error) }` };
    }
  }
}
