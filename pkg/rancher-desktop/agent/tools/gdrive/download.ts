import fs from 'fs/promises';
import path from 'path';

import { DriveTool, FOLDER_MIME, parseDriveId } from './common';

import { resolveSullaHomeDir } from '@pkg/agent/utils/sullaPaths';

/** Export targets for Google-native files, keyed by the `format` input. */
const EXPORT_FORMATS: Record<string, { mime: string; ext: string }> = {
  pdf:  { mime: 'application/pdf', ext: 'pdf' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx' },
  md:   { mime: 'text/markdown', ext: 'md' },
  txt:  { mime: 'text/plain', ext: 'txt' },
  csv:  { mime: 'text/csv', ext: 'csv' },
  png:  { mime: 'image/png', ext: 'png' },
  svg:  { mime: 'image/svg+xml', ext: 'svg' },
};

const DEFAULT_FORMAT: Record<string, string> = {
  'application/vnd.google-apps.document':     'pdf',
  'application/vnd.google-apps.spreadsheet':  'xlsx',
  'application/vnd.google-apps.presentation': 'pdf',
  'application/vnd.google-apps.drawing':      'png',
};

function safeName(name: string): string {
  return name.replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').slice(0, 150) || 'file';
}

export class GdriveDownloadWorker extends DriveTool {
  protected async _validatedCall(input: any) {
    const accountId = input.accountId ? String(input.accountId) : undefined;
    const file = await this.resolveFile(parseDriveId(input.file), accountId);
    if (file.mimeType === FOLDER_MIME) {
      throw new Error(`"${ file.name }" is a folder. Download its files one at a time (gdrive/list_folder lists them).`);
    }

    const dir = input.destinationDir ? String(input.destinationDir) : path.join(resolveSullaHomeDir(), 'cache', 'gdrive');
    await fs.mkdir(dir, { recursive: true });

    let res: Response;
    let fileName = safeName(file.name);
    if (file.mimeType.startsWith('application/vnd.google-apps.')) {
      const formatKey = String(input.format || DEFAULT_FORMAT[file.mimeType] || '');
      const format = EXPORT_FORMATS[formatKey];
      if (!format) {
        throw new Error(`Google ${ file.mimeType.split('.').pop() } files need a format: one of ${ Object.keys(EXPORT_FORMATS).join(', ') }.`);
      }
      res = await this.driveFetch(`/files/${ encodeURIComponent(file.id) }/export`, { mimeType: format.mime }, accountId);
      if (!fileName.toLowerCase().endsWith(`.${ format.ext }`)) fileName = `${ fileName }.${ format.ext }`;
    } else {
      res = await this.driveFetch(`/files/${ encodeURIComponent(file.id) }`, { alt: 'media', supportsAllDrives: true }, accountId);
    }

    const target = path.join(dir, `${ file.id.slice(0, 8) }-${ fileName }`);
    const bytes = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(target, bytes);

    return this.response({ ...this.summarize(file), savedTo: target, bytes: bytes.length });
  }
}
