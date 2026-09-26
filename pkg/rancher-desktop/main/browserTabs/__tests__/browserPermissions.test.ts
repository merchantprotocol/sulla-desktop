/**
 * @jest-environment node
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it, jest } from '@jest/globals';

import { BrowserPermissionPolicy, SitePermissionStore, permissionKey } from '../browserPermissions';

function policy(answer = true, file: string | null = null) {
  const prompt = jest.fn((_origin: string, _description: string) => Promise.resolve(answer));

  return { prompt, policy: new BrowserPermissionPolicy(new SitePermissionStore(file), prompt) };
}

const site = 'https://meet.example';

describe('BrowserPermissionPolicy', () => {
  it('prompts once for camera/mic and remembers the answer', async() => {
    const { prompt, policy: p } = policy(true);
    const req = { permission: 'media', origin: site, details: { mediaTypes: ['audio', 'video'] }, userVisible: true };

    expect(p.check('media', site, req.details)).toBe(false);
    await expect(p.request(req)).resolves.toBe(true);
    await expect(p.request(req)).resolves.toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0][1]).toBe('use your camera and microphone');
    expect(p.check('media', site, req.details)).toBe(true);
  });

  it('keeps camera and microphone as separate grants', () => {
    expect(permissionKey('media', { mediaTypes: ['audio'] })).not.toBe(permissionKey('media', { mediaTypes: ['video'] }));
  });

  it('remembers a block and never re-prompts', async() => {
    const { prompt, policy: p } = policy(false);
    const req = { permission: 'geolocation', origin: site, userVisible: true };

    await expect(p.request(req)).resolves.toBe(false);
    await expect(p.request(req)).resolves.toBe(false);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('denies without prompting for pages the user cannot see, and does not remember it', async() => {
    const { prompt, policy: p } = policy(true);

    await expect(p.request({ permission: 'geolocation', origin: site, userVisible: false })).resolves.toBe(false);
    expect(prompt).not.toHaveBeenCalled();
    await expect(p.request({ permission: 'geolocation', origin: site, userVisible: true })).resolves.toBe(true);
  });

  it('coalesces concurrent identical requests into one prompt', async() => {
    const { prompt, policy: p } = policy(true);
    const req = { permission: 'clipboard-read', origin: site, userVisible: true };

    await Promise.all([p.request(req), p.request(req), p.request(req)]);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('allows harmless capabilities and denies unknown or origin-less requests', async() => {
    const { prompt, policy: p } = policy(true);

    await expect(p.request({ permission: 'fullscreen', origin: site, userVisible: false })).resolves.toBe(true);
    await expect(p.request({ permission: 'mediaKeySystem', origin: site, userVisible: false })).resolves.toBe(true);
    await expect(p.request({ permission: 'unknown', origin: site, userVisible: true })).resolves.toBe(false);
    await expect(p.request({ permission: 'media', origin: null, userVisible: true })).resolves.toBe(false);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('persists decisions across restarts', async() => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'perm-')), 'site-permissions.json');
    const first = policy(true, file);
    await first.policy.request({ permission: 'geolocation', origin: site, userVisible: true });

    const second = policy(false, file);
    await expect(second.policy.request({ permission: 'geolocation', origin: site, userVisible: true })).resolves.toBe(true);
    expect(second.prompt).not.toHaveBeenCalled();
  });
});
