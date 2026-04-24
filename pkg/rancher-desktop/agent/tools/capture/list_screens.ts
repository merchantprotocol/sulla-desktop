import { desktopCapturer } from 'electron';

import { BaseTool, ToolResponse } from '../base';

/**
 * List screens and/or windows available for capture. The thumbnail size
 * is intentionally small (160×90) — agents use this for selection, not
 * inspection. Use capture/screenshot with the returned id for a full
 * image.
 */
export class ListScreensWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const kind = String(input.kind || 'all').trim().toLowerCase();
    const types: ('screen' | 'window')[] =
      kind === 'screen' ? ['screen']
      : kind === 'window' ? ['window']
      : ['screen', 'window'];

    const sources = await desktopCapturer.getSources({
      types,
      thumbnailSize: { width: 160, height: 90 },
      fetchWindowIcons: false,
    });

    if (sources.length === 0) {
      return { successBoolean: true, responseString: 'No capturable sources found.' };
    }

    const lines = [`${ sources.length } source(s):\n`];
    for (const s of sources) {
      const type = s.id.startsWith('screen:') ? 'screen' : 'window';
      lines.push(`- **${ s.id }** [${ type }] ${ s.name || '(untitled)' }`);
    }

    return { successBoolean: true, responseString: lines.join('\n') };
  }
}
