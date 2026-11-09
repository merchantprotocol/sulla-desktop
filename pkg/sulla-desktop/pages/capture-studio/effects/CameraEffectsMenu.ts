// SPDX-License-Identifier: GPL-2.0-or-later
import type { CtxMenuItem } from '../ContextMenuItem';
import type { CameraStreamService } from './CameraStreamService';
import type { EffectOptions } from './FrameCompositor';

/** Builds camera-only controls using the existing context menu's choice flyouts. */
export class CameraEffectsMenu {
  private busy = false;

  constructor(
    private readonly camera: CameraStreamService,
    private readonly locked: () => boolean,
    private readonly notify: (message: string) => void,
    private readonly changed: () => void,
  ) {}

  items(): CtxMenuItem[] {
    const options = this.camera.effectOptions;
    const disabled = this.busy || this.locked();
    return [
      { id: 'effects-section', label: 'Camera effects', divider: true, action: () => {} },
      {
        id: 'effect-framing', label: 'Smooth auto-framing', active: options.autoFrame, disabled,
        action: () => { void this.apply({ ...options, autoFrame: !options.autoFrame }); },
      },
      ...(['soften', 'backgroundBlur'] as const).map(key => ({
        id: 'effect-' + key,
        label: key === 'soften' ? 'Appearance softening' : 'Light background blur',
        active: options[key] > 0, disabled,
        children: [0, 0.15, 0.2, 0.35, 0.5, 0.75, 1].map(value => ({
          id: key + '-' + value,
          label: value === 0 ? 'Off' : Math.round(value * 100) + '%',
          active: options[key] === value, disabled,
          action: () => { void this.apply({ ...options, [key]: value }); },
        })),
        action: () => {},
      })),
    ];
  }

  private async apply(options: EffectOptions): Promise<void> {
    if (this.busy) return;
    try {
      this.camera.assertMutable();
      if (this.locked()) throw new Error('Stop recording before changing camera effects');
      this.busy = true;
      this.changed();
      await this.camera.setOptions(options);
    } catch (error) {
      this.notify(error instanceof Error ? error.message : 'Could not change camera effects');
    } finally {
      this.busy = false;
      this.changed();
    }
  }
}
