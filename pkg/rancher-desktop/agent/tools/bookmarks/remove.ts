import { BookmarkTool } from './common';

export class BookmarksRemoveWorker extends BookmarkTool {
  protected async _validatedCall(input: any) {
    const all = await this.service().list();
    const record = all.find(item => item.id === input.id);
    if (!record) throw new Error(`Bookmark "${ input.id }" was not found.`);
    const nonEmptyFolder = record.kind === 'folder' && all.some(item => item.parent_id === record.id);
    if (nonEmptyFolder && input.recursive !== true) {
      throw new Error('Non-empty bookmark folders require recursive: true.');
    }

    const removed = await this.service().remove(record.id, { recursive: input.recursive === true });
    if (!removed) throw new Error(`Bookmark "${ input.id }" was not found.`);

    return this.response({ removed: true, id: record.id });
  }
}
