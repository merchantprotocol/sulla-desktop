// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

const forbidden = () => { throw new Error('Electron stub was used; only the Desktop Node stream path is allowed'); };

export const safeStorage = { isEncryptionAvailable: forbidden, decryptString: forbidden, encryptString: forbidden };
export const session = { fromPartition: forbidden };
export const app = { on: forbidden, getPath: forbidden, isPackaged: false };

export default { safeStorage, session, app };
