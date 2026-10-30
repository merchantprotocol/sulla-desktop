// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, jest } from '@jest/globals';
import { registerOrSignIn } from '../cloudEmailContinueDecision';

describe('registerOrSignIn', () => {
  it('returns a new registration without trying login', async() => {
    const login = jest.fn<() => Promise<any>>();
    const result = await registerOrSignIn(async() => ({ ok: true, data: { id: 'new' } }), login);
    expect(result).toMatchObject({ ok: true, isNewUser: true, data: { id: 'new' } });
    expect(login).not.toHaveBeenCalled();
  });

  it('turns register 409 into login', async() => {
    const login = jest.fn<() => Promise<any>>().mockResolvedValue({ ok: true, data: { id: 'existing' } });
    const result = await registerOrSignIn(async() => ({ ok: false, httpStatus: 409 }), login);
    expect(login).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, accountExists: true, isNewUser: false, data: { id: 'existing' } });
  });
});
