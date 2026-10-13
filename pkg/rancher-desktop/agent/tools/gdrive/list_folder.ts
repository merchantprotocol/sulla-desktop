import { DriveTool, FOLDER_MIME, parseDriveId, type DriveFile } from './common';

const MAX_ITEMS = 2000;
const MAX_DEPTH = 6;

export class GdriveListFolderWorker extends DriveTool {
  protected async _validatedCall(input: any) {
    const folderId = parseDriveId(input.folder ?? 'root');
    const accountId = input.accountId ? String(input.accountId) : undefined;
    const recursive = input.recursive === true;
    const depthLimit = Math.min(Math.max(Number(input.maxDepth ?? MAX_DEPTH), 1), MAX_DEPTH);

    if (!recursive) {
      const page = await this.listChildren(folderId, accountId, input.pageToken ? String(input.pageToken) : undefined);

      return this.response({
        folder:        folderId,
        count:         page.files.length,
        items:         page.files.map(file => this.summarize(file)),
        nextPageToken: page.nextPageToken,
      });
    }

    // Breadth-first walk so a large tree still returns its top levels first when capped.
    const items: Record<string, unknown>[] = [];
    const queue: { id: string; path: string; depth: number }[] = [{ id: folderId, path: '', depth: 1 }];
    let truncated = false;

    while (queue.length && !truncated) {
      const { id, path, depth } = queue.shift()!;
      let pageToken: string | undefined;
      do {
        const page = await this.listChildren(id, accountId, pageToken, 1000);
        for (const file of page.files as DriveFile[]) {
          const childPath = path ? `${ path }/${ file.name }` : file.name;
          items.push(this.summarize(file, childPath));
          if (file.mimeType === FOLDER_MIME && depth < depthLimit) queue.push({ id: file.id, path: childPath, depth: depth + 1 });
          if (items.length >= MAX_ITEMS) {
            truncated = true;
            break;
          }
        }
        pageToken = truncated ? undefined : page.nextPageToken;
      } while (pageToken);
    }

    return this.response({
      folder: folderId,
      count:  items.length,
      ...(truncated ? { truncated: `Stopped at ${ MAX_ITEMS } items; list subfolders individually for the rest.` } : {}),
      items,
    });
  }
}
