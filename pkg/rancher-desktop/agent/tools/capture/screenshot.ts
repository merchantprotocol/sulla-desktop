import fs from 'node:fs';
import path from 'node:path';

import { desktopCapturer, screen as electronScreen } from 'electron';

import { resolveSullaHomeDir } from '@pkg/agent/utils/sullaPaths';

import { BaseTool, ToolResponse } from '../base';

/**
 * Take a PNG screenshot of a screen or window via desktopCapturer and
 * save it under `~/sulla/captures/screenshots/`. Returns the absolute
 * path to the file so the agent can Read it.
 */
export class ScreenshotWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const sourceId = typeof input.sourceId === 'string' ? input.sourceId.trim() : '';
    const kind = sourceId.startsWith('window:') ? 'window'
      : sourceId.startsWith('screen:') ? 'screen'
      : 'screen';

    // Use the primary display's resolution as the thumbnail target so
    // the returned NativeImage is pixel-accurate, not a 160×90 preview.
    const primary = electronScreen.getPrimaryDisplay();
    const { width, height } = primary.size;
    const scaleFactor = primary.scaleFactor || 1;
    const thumbSize = {
      width:  Math.round(width  * scaleFactor),
      height: Math.round(height * scaleFactor),
    };

    const sources = await desktopCapturer.getSources({
      types:         [kind],
      thumbnailSize: thumbSize,
    });

    let source = sources[0];
    if (sourceId) {
      const match = sources.find(s => s.id === sourceId);
      if (!match) {
        return {
          successBoolean: false,
          responseString: `sourceId "${ sourceId }" not found — call capture/list_screens to see valid ids.`,
        };
      }
      source = match;
    }
    if (!source) {
      return { successBoolean: false, responseString: 'No capturable source available.' };
    }

    const pngBuffer = source.thumbnail.toPNG();
    if (!pngBuffer || pngBuffer.length === 0) {
      return { successBoolean: false, responseString: 'Screenshot produced an empty buffer.' };
    }

    // ~/sulla/captures/screenshots/YYYY-MM-DD/screenshot-{epochMs}.png
    const now = new Date();
    const y   = now.getFullYear();
    const m   = String(now.getMonth() + 1).padStart(2, '0');
    const d   = String(now.getDate()).padStart(2, '0');
    const day = `${ y }-${ m }-${ d }`;
    const dir = path.join(resolveSullaHomeDir(), 'captures', 'screenshots', day);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `screenshot-${ Date.now() }.png`);
    fs.writeFileSync(file, pngBuffer);

    const size = source.thumbnail.getSize();
    return {
      successBoolean: true,
      responseString: [
        `Screenshot saved.`,
        `- path: ${ file }`,
        `- source: ${ source.id } (${ source.name || kind })`,
        `- dimensions: ${ size.width }×${ size.height }`,
        `- bytes: ${ pngBuffer.length }`,
      ].join('\n'),
    };
  }
}
