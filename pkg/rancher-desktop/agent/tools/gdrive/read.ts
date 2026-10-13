import { DriveTool, FOLDER_MIME, TEXT_EXPORTS, friendlyType, isTextMime, parseDriveId } from './common';

const DEFAULT_MAX_CHARS = 100_000;

export class GdriveReadWorker extends DriveTool {
  protected async _validatedCall(input: any) {
    const accountId = input.accountId ? String(input.accountId) : undefined;
    const file = await this.resolveFile(parseDriveId(input.file), accountId);
    const maxChars = Math.max(Number(input.maxChars ?? DEFAULT_MAX_CHARS), 1000);
    const meta = this.summarize(file);

    if (file.mimeType === FOLDER_MIME) {
      throw new Error(`"${ file.name }" is a folder. Use gdrive/list_folder to see what is inside it.`);
    }

    let text: string;
    let format: string;
    const exportMime = TEXT_EXPORTS[file.mimeType];
    if (exportMime) {
      const res = await this.driveFetch(`/files/${ encodeURIComponent(file.id) }/export`, { mimeType: exportMime }, accountId);
      text = await res.text();
      format = exportMime;
    } else if (isTextMime(file.mimeType)) {
      const res = await this.driveFetch(`/files/${ encodeURIComponent(file.id) }`, { alt: 'media', supportsAllDrives: true }, accountId);
      text = await res.text();
      format = file.mimeType;
    } else {
      return this.response({
        ...meta,
        content: null,
        note:    `${ friendlyType(file.mimeType) } files are not text. Use gdrive/download to save it locally, then read or view the saved file.`,
      });
    }

    const truncated = text.length > maxChars;

    return this.response({
      ...meta,
      format,
      ...(file.mimeType === 'application/vnd.google-apps.spreadsheet' ? { note: 'Google Sheets export as CSV includes only the first tab.' } : {}),
      ...(truncated ? { truncated: `Showing ${ maxChars } of ${ text.length } characters; raise maxChars to read more.` } : {}),
      content: truncated ? text.slice(0, maxChars) : text,
    });
  }
}
