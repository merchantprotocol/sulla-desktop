import { BookmarkTool } from './common';

export class BookmarksMoveWorker extends BookmarkTool {
  protected async _validatedCall(input: any) {
    if (input.parentId === undefined && input.index === undefined) throw new Error('Provide parentId, index, or both.');
    const all = await this.service().list();
    const record = all.find(item => item.id === input.id);
    if (!record) throw new Error(`Bookmark "${ input.id }" was not found.`);

    const parentId = input.parentId === undefined
      ? record.parent_id ?? null
      : (String(input.parentId).trim() || null);
    if (parentId) this.findFolder(all, parentId);
    const siblingCount = all.filter(item => item.id !== record.id && (item.parent_id ?? null) === parentId).length;
    const index = input.index === undefined ? siblingCount : input.index;
    const moved = await this.service().move(record.id, parentId, index);

    return this.response(this.output(moved));
  }
}
