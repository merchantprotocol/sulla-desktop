// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { providerCliContainerSettings, providerCliSnapshotForSelection } from '@pkg/shared/providerCliSelection';

describe('durable provider CLI selections', () => {
  it('captures an explicit image-default marker for every CLI provider', () => {
    const snapshot = providerCliSnapshotForSelection({});
    expect(snapshot).toEqual({
      'claude-code': { mode: 'image-default' }, codex: { mode: 'image-default' },
      opencode: { mode: 'image-default' }, cursor: { mode: 'image-default' },
    });
    expect(providerCliContainerSettings(snapshot)).toEqual({ binds: [], env: {}, pinned: [] });
  });

  it('binds exact selected releases read-only and leaves other provider image defaults intact', () => {
    const snapshot = providerCliSnapshotForSelection({ 'claude-code': '2.2.0', codex: '0.163.0' });
    const result = providerCliContainerSettings(snapshot);
    expect(result.binds).toEqual([
      '/mnt/data/sulla/provider-clis/claude-code/2.2.0:/opt/sulla-provider-clis/claude-code/2.2.0:ro',
      '/mnt/data/sulla/provider-clis/codex/0.163.0:/opt/sulla-provider-clis/codex/0.163.0:ro',
    ]);
    expect(result.env.PATH.startsWith('/opt/sulla-provider-clis/claude-code/2.2.0/node_modules/.bin:/opt/sulla-provider-clis/codex/0.163.0/node_modules/.bin:')).toBe(true);
    expect(snapshot.opencode).toEqual({ mode: 'image-default' });
  });

  it('rejects unrepresentable, incomplete, or corrupted snapshots instead of silently selecting the image default', () => {
    expect(() => providerCliSnapshotForSelection({ codex: '0.163.0; touch /tmp/bad' })).toThrow('invalid');
    expect(() => providerCliSnapshotForSelection({ opencode: '1.0.0' })).toThrow('image-default fallback');
    expect(() => providerCliContainerSettings({ 'claude-code': { mode: 'versioned', version: '2.2.0' } } as any)).toThrow('incomplete');
    expect(() => providerCliContainerSettings({ ...providerCliSnapshotForSelection({}), codex: { mode: 'versioned', version: '../../bad' } } as any)).toThrow('Unsupported provider CLI version');
  });

  it('treats legacy tasks with no snapshot as image-default even if a newer global choice exists', () => {
    expect(providerCliContainerSettings(undefined)).toEqual({ binds: [], env: {}, pinned: [] });
  });
});
