import { BookmarkTool } from './common';

export class BookmarksAddWorker extends BookmarkTool {
  protected async _validatedCall(input: any) {
    const folder = await this.resolveDestination(input);
    const url = this.normalizeUrl(input.url);
    const existing = (await this.service().list()).find(record =>
      record.kind === 'bookmark' &&
      (record.parent_id ?? null) === folder.id &&
      record.url === url,
    );
    if (existing) return this.response({ created: false, bookmark: this.output(existing) });

    const bookmark = await this.service().create({
      kind:     'bookmark',
      url,
      title:    input.title,
      parentId: folder.id,
    });

    return this.response({ created: true, bookmark: this.output(bookmark) });
  }
}
