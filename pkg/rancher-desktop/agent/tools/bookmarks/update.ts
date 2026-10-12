import { BookmarkTool } from './common';

export class BookmarksUpdateWorker extends BookmarkTool {
  protected async _validatedCall(input: any) {
    if (input.title === undefined && input.url === undefined) throw new Error('Provide title, url, or both.');
    const updated = await this.service().update(input.id, { title: input.title, url: input.url });
    if (!updated) throw new Error(`Bookmark "${ input.id }" was not found.`);

    return this.response(this.output(updated));
  }
}
