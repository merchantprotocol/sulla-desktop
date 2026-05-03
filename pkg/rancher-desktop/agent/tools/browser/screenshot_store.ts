// Screenshot store — writes captured screenshots to disk and returns a
// compact reference instead of inline base64. Prevents multi-MB payloads
// from flowing through tool results, IPC, message state, or localStorage.
//
// Layout:
//   ~/sulla/artifacts/screenshots/<assetId>.jpg        full image
//   ~/sulla/artifacts/screenshots/<assetId>.thumb.jpg  300px-wide thumbnail

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { nativeImage } from 'electron';

import paths from '@pkg/utils/paths';

const SCREENSHOT_DIR = path.join(paths.sullaHome, 'artifacts', 'screenshots');
const THUMBNAIL_WIDTH = 300;
const THUMBNAIL_QUALITY = 60;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface ScreenshotRef {
  assetId:       string;
  path:          string;
  thumbnailPath: string;
  width:         number;
  height:        number;
  bytes:         number;
  mediaType:     string;
  capturedAt:    string;
}

function ensureDir(): void {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

function newAssetId(): string {
  return `ss_${ crypto.randomBytes(8).toString('hex') }`;
}

export async function saveScreenshot(base64: string, mediaType: string): Promise<ScreenshotRef> {
  ensureDir();

  const assetId = newAssetId();
  const ext = mediaType === 'image/png' ? 'png' : 'jpg';
  const fullPath = path.join(SCREENSHOT_DIR, `${ assetId }.${ ext }`);
  const thumbPath = path.join(SCREENSHOT_DIR, `${ assetId }.thumb.jpg`);

  const buf = Buffer.from(base64, 'base64');
  await fs.promises.writeFile(fullPath, buf);

  const img = nativeImage.createFromBuffer(buf);
  const { width, height } = img.getSize();

  const thumbBuf = width > THUMBNAIL_WIDTH
    ? img.resize({ width: THUMBNAIL_WIDTH, quality: 'good' }).toJPEG(THUMBNAIL_QUALITY)
    : img.toJPEG(THUMBNAIL_QUALITY);
  await fs.promises.writeFile(thumbPath, thumbBuf);

  return {
    assetId,
    path:          fullPath,
    thumbnailPath: thumbPath,
    width,
    height,
    bytes:         buf.byteLength,
    mediaType,
    capturedAt:    new Date().toISOString(),
  };
}

/** Delete screenshot artifacts older than MAX_AGE_MS. Runs best-effort. */
export async function pruneOldScreenshots(): Promise<void> {
  try {
    ensureDir();
    const entries = await fs.promises.readdir(SCREENSHOT_DIR);
    const cutoff = Date.now() - MAX_AGE_MS;
    let deleted = 0;

    for (const name of entries) {
      const p = path.join(SCREENSHOT_DIR, name);
      try {
        const stat = await fs.promises.stat(p);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          await fs.promises.unlink(p);
          deleted++;
        }
      } catch { /* entry disappeared mid-scan */ }
    }

    if (deleted > 0) {
      console.log(`[screenshotStore] Pruned ${ deleted } screenshots older than ${ MAX_AGE_MS / 3_600_000 }h`);
    }
  } catch (err) {
    console.warn('[screenshotStore] Prune failed:', err instanceof Error ? err.message : err);
  }
}
