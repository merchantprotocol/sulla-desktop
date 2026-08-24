import { describe, expect, it } from '@jest/globals';

import {
  browserAssetId,
  graphBrowserControllerContext,
  isGraphBrowserControllerEnabled,
  normalizeGraphBrowserArgs,
} from '../graphBrowserController';

import type { BaseThreadState } from '../../nodes/Graph';

function state(metadata: Record<string, unknown>): BaseThreadState {
  return { metadata } as unknown as BaseThreadState;
}

describe('scheduled graph Browser controller policy', () => {
  it('enables only an explicitly capable graph with a visible browser', () => {
    const allowedToolNames = ['exec', 'browser_controller'];
    expect(isGraphBrowserControllerEnabled(state({ graphNativeBrowserController: true, allowedToolNames }))).toBe(true);
    expect(isGraphBrowserControllerEnabled(state({ graphNativeBrowserController: true }))).toBe(false);
    expect(isGraphBrowserControllerEnabled(state({ graphNativeBrowserController: true, allowedToolNames, userVisibleBrowser: false }))).toBe(false);
    expect(isGraphBrowserControllerEnabled(state({}))).toBe(false);
  });

  it('keeps ordinary chat context unchanged and documents scheduled delegation', () => {
    expect(graphBrowserControllerContext(state({}))).toBe('');
    expect(graphBrowserControllerContext(state({
      graphNativeBrowserController: true,
      allowedToolNames:             ['browser_controller'],
    })))
      .toContain('mcp__sulla_native__browser_controller');
  });

  it('derives stable graph-scoped iab asset ids and reuses them', () => {
    const id = browserAssetId('heartbeat_123', 'http://127.0.0.1:5173/settings');
    expect(id).toBe('iab_heartbeat_123_127-0-0-1-settings');
    expect(normalizeGraphBrowserArgs('tab', { action: 'upsert', url: 'http://127.0.0.1:5173/settings' }, 'heartbeat_123'))
      .toMatchObject({ assetId: id });
    expect(normalizeGraphBrowserArgs('screenshot', {}, 'heartbeat_123', id))
      .toEqual({ assetId: id });
  });

  it('overrides caller-supplied asset ids and rejects use before graph ownership exists', () => {
    const id = browserAssetId('heartbeat_123', 'http://127.0.0.1:5173/settings');

    expect(normalizeGraphBrowserArgs(
      'tab',
      { action: 'upsert', url: 'http://127.0.0.1:5173/settings', assetId: 'user_private_tab' },
      'heartbeat_123',
    )).toMatchObject({ assetId: id });
    expect(normalizeGraphBrowserArgs('screenshot', { assetId: 'user_private_tab' }, 'heartbeat_123', id))
      .toEqual({ assetId: id });
    expect(() => normalizeGraphBrowserArgs('screenshot', {}, 'heartbeat_123'))
      .toThrow('no graph-owned tab');
  });
});
