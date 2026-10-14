/** @jest-environment node */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { getInstallId } from '@pkg/main/installId';

describe('getInstallId', () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-install-id-'));
  });

  afterEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true });
  });

  it('generates a UUID once and persists it in userData', () => {
    const first = getInstallId(userDataPath);
    const second = getInstallId(userDataPath);

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(second).toBe(first);
    expect(fs.readFileSync(path.join(userDataPath, 'install-id'), 'utf8')).toBe(first);
  });
});
