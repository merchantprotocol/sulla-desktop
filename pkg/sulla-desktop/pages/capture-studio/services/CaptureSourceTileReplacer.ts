// SPDX-License-Identifier: GPL-2.0-or-later
export interface CaptureScreenTile {
  id: string;
  type: string;
  name: string;
  status: string;
  on: boolean;
}

/** Replaces the source bound to one existing screen tile; it never creates or reassigns tiles. */
export class CaptureSourceTileReplacer {
  constructor(
    private readonly acquire: (tileId: string, deviceId: string) => Promise<unknown>,
    private readonly updateAssignments: () => void,
  ) {}

  async replace(tile: CaptureScreenTile, deviceId: string, name: string): Promise<void> {
    if (tile.type !== 'screen') throw new Error('Only a screen tile can change screen source');
    await this.acquire(tile.id, deviceId);
    tile.name = name;
    tile.status = 'Capturing';
    tile.on = true;
    this.updateAssignments();
  }
}
