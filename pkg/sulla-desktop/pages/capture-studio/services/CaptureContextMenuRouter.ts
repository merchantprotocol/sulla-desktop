// SPDX-License-Identifier: GPL-2.0-or-later
export interface CaptureMenuSource {
  id: string;
  type: string;
}

export interface CaptureContextMenuHandlers {
  screen: (event: MouseEvent, sourceId: string) => void;
  camera: (event: MouseEvent, sourceId: string) => void;
  audio: (event: MouseEvent, sourceId: string) => void;
}

/** Routes a source-tile context menu to the handler for that exact source. */
export class CaptureContextMenuRouter {
  open(sourceId: string | undefined, sources: readonly CaptureMenuSource[], event: MouseEvent, handlers: CaptureContextMenuHandlers): void {
    const source = sources.find(candidate => candidate.id === sourceId);
    if (!source) return;

    if (source.type === 'screen') handlers.screen(event, source.id);
    else if (source.type === 'camera') handlers.camera(event, source.id);
    else if (source.type === 'mic' || source.type === 'system') handlers.audio(event, source.id);
  }
}
