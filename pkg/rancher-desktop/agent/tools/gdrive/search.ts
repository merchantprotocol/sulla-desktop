import { DriveTool, FILE_FIELDS, parseDriveId, type DriveFile } from './common';

function quote(value: string): string {
  return `'${ value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") }'`;
}

export class GdriveSearchWorker extends DriveTool {
  protected async _validatedCall(input: any) {
    const text = String(input.query ?? '').trim();
    const rawQ = String(input.q ?? '').trim();
    if (!text && !rawQ) throw new Error('Pass query (plain text) or q (Drive query syntax).');

    const clauses = ['trashed = false'];
    if (text) clauses.push(`(name contains ${ quote(text) } or fullText contains ${ quote(text) })`);
    if (rawQ) clauses.push(`(${ rawQ })`);
    if (input.folder) clauses.push(`${ quote(parseDriveId(String(input.folder))) } in parents`);
    if (input.mimeType) clauses.push(`mimeType = ${ quote(String(input.mimeType)) }`);

    const res = await this.driveFetch('/files', {
      q:                         clauses.join(' and '),
      fields:                    `nextPageToken,files(${ FILE_FIELDS })`,
      pageSize:                  Math.min(Math.max(Number(input.limit ?? 50), 1), 200),
      pageToken:                 input.pageToken ? String(input.pageToken) : undefined,
      supportsAllDrives:         true,
      includeItemsFromAllDrives: true,
      corpora:                   'allDrives',
    }, input.accountId ? String(input.accountId) : undefined);
    const page = await res.json() as { files: DriveFile[]; nextPageToken?: string };

    return this.response({
      count:         page.files.length,
      items:         page.files.map(file => this.summarize(file)),
      nextPageToken: page.nextPageToken,
    });
  }
}
