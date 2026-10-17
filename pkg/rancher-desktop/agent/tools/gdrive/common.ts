import { BaseTool, type ToolResponse } from '../base';

import { getIntegrationService } from '@pkg/agent/services/IntegrationService';
import { requireConfiguredCredentialBroker, usesContainerVaultAuthority } from '@pkg/vault-broker';

/** Integration id the Google Drive card stores its OAuth tokens under. */
export const GDRIVE_INTEGRATION_ID = 'google_drive';

const API_BASE = 'https://www.googleapis.com/drive/v3';

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

export const FILE_FIELDS = 'id,name,mimeType,modifiedTime,size,webViewLink,parents,description,owners(displayName,emailAddress),shortcutDetails(targetId,targetMimeType)';

/** How each Google-native type is turned into text an agent can read. */
export const TEXT_EXPORTS: Record<string, string> = {
  'application/vnd.google-apps.document':     'text/markdown',
  'application/vnd.google-apps.spreadsheet':  'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.drawing':      'image/svg+xml',
  'application/vnd.google-apps.script':       'application/vnd.google-apps.script+json',
};

export interface DriveFile {
  id:               string;
  name:             string;
  mimeType:         string;
  modifiedTime?:    string;
  size?:            string;
  webViewLink?:     string;
  parents?:         string[];
  description?:     string;
  owners?:          { displayName?: string; emailAddress?: string }[];
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
}

/**
 * Accepts a bare Drive id or any Drive/Docs/Sheets/Slides URL and returns the id.
 * e.g. https://drive.google.com/drive/u/0/folders/<id>, https://docs.google.com/document/d/<id>/edit,
 * https://drive.google.com/open?id=<id>
 */
export function parseDriveId(input: string): string {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('A Google Drive file/folder id or URL is required.');
  if (!/^https?:\/\//i.test(raw)) return raw;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${ raw }`);
  }
  const pathMatch = url.pathname.match(/\/(?:folders|d)\/([A-Za-z0-9_-]{10,})/);
  if (pathMatch) return pathMatch[1];
  const idParam = url.searchParams.get('id');
  if (idParam) return idParam;
  throw new Error(`Could not find a Drive id in ${ raw }`);
}

export function isTextMime(mime: string): boolean {
  return mime.startsWith('text/') ||
    ['application/json', 'application/xml', 'application/javascript', 'application/x-yaml', 'application/yaml'].includes(mime);
}

export abstract class DriveTool extends BaseTool {
  name = '';
  description = '';

  protected response(value: unknown): ToolResponse {
    return { successBoolean: true, responseString: typeof value === 'string' ? value : JSON.stringify(value, null, 2) };
  }

  protected async accessToken(accountId?: string): Promise<string> {
    const svc = getIntegrationService();
    const account = accountId || await svc.getActiveAccountId(GDRIVE_INTEGRATION_ID);
    try {
      return await svc.getOAuthAccessToken(GDRIVE_INTEGRATION_ID, account);
    } catch (err: any) {
      throw new Error(`Google Drive is not connected (${ err?.message || err }). Open Integrations → Google Drive and click "Connect with Google".`);
    }
  }

  /** Authenticated Drive API request. Returns the raw Response so callers pick json/text/bytes. */
  protected async driveFetch(path: string, query: Record<string, string | number | boolean | undefined>, accountId?: string): Promise<Response> {
    const url = new URL(`${ API_BASE }${ path }`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    const account = accountId || await getIntegrationService().getActiveAccountId(GDRIVE_INTEGRATION_ID);
    let res: Response;

    if (usesContainerVaultAuthority()) {
      const ctx = this.executionContext;
      if (!ctx || ctx.credential_scope?.integration_id !== GDRIVE_INTEGRATION_ID || ctx.credential_scope.account_id !== account) {
        throw new Error('Google Drive requires a verified credential scope for the selected account');
      }
      const broker = requireConfiguredCredentialBroker();
      res = await broker.executeStream(broker.requestFor(ctx, {
        operation:    'catalog.http',
        ref:          { integrationId: GDRIVE_INTEGRATION_ID, accountId: account },
        url:          url.toString(),
        method:       'GET',
        injections:   [{ field: 'access_token', target: 'header', name: 'authorization', scheme: 'Bearer' }],
        responseType: 'stream',
      }));
    } else {
      res = await fetch(url, { headers: { Authorization: `Bearer ${ await this.accessToken(account) }` } });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let message = body;
      try {
        message = JSON.parse(body)?.error?.message || body;
      } catch { /* not JSON */ }
      if (res.status === 401) throw new Error(`Google rejected the Drive token (401): ${ message }. Reconnect Google Drive in Integrations.`);
      if (res.status === 403) throw new Error(`Google Drive denied access (403): ${ message }. The connected account may not have access to this item, or the Drive API is not enabled for the OAuth client's Google Cloud project.`);
      if (res.status === 404) throw new Error(`Not found in Google Drive (404): ${ message }. Check the id, and that the connected Google account can open it.`);
      throw new Error(`Google Drive API ${ res.status }: ${ message }`);
    }

    return res;
  }

  protected async getFile(fileId: string, accountId?: string): Promise<DriveFile> {
    const res = await this.driveFetch(`/files/${ encodeURIComponent(fileId) }`, { fields: FILE_FIELDS, supportsAllDrives: true }, accountId);

    return await res.json() as DriveFile;
  }

  /** Resolves shortcuts to the file they point at. */
  protected async resolveFile(fileId: string, accountId?: string): Promise<DriveFile> {
    const file = await this.getFile(fileId, accountId);
    if (file.mimeType === SHORTCUT_MIME && file.shortcutDetails?.targetId) {
      return this.getFile(file.shortcutDetails.targetId, accountId);
    }

    return file;
  }

  protected async listChildren(folderId: string, accountId?: string, pageToken?: string, pageSize = 200): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
    const res = await this.driveFetch('/files', {
      q:                         `'${ folderId.replace(/'/g, "\\'") }' in parents and trashed = false`,
      fields:                    `nextPageToken,files(${ FILE_FIELDS })`,
      orderBy:                   'folder,name',
      pageSize,
      pageToken,
      supportsAllDrives:         true,
      includeItemsFromAllDrives: true,
    }, accountId);

    return await res.json() as { files: DriveFile[]; nextPageToken?: string };
  }

  protected summarize(file: DriveFile, path?: string) {
    return {
      id:       file.id,
      name:     file.name,
      ...(path ? { path } : {}),
      type:     friendlyType(file.mimeType),
      mimeType: file.mimeType,
      modified: file.modifiedTime,
      ...(file.size ? { sizeBytes: Number(file.size) } : {}),
      link:     file.webViewLink,
      ...(file.shortcutDetails?.targetId ? { shortcutTo: file.shortcutDetails.targetId } : {}),
    };
  }
}

export function friendlyType(mime: string): string {
  const map: Record<string, string> = {
    [FOLDER_MIME]:                              'folder',
    [SHORTCUT_MIME]:                            'shortcut',
    'application/vnd.google-apps.document':     'google-doc',
    'application/vnd.google-apps.spreadsheet':  'google-sheet',
    'application/vnd.google-apps.presentation': 'google-slides',
    'application/vnd.google-apps.drawing':      'google-drawing',
    'application/vnd.google-apps.form':         'google-form',
    'application/pdf':                          'pdf',
  };
  if (map[mime]) return map[mime];
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (isTextMime(mime)) return 'text';

  return 'file';
}
