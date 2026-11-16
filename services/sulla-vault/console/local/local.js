// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Entry module for the local vault page. The page logic lives in app/ (one class per
// screen; VaultConsoleApp composes them). customFields.js is a classic script loaded
// first and exposes globalThis.SullaVaultCustomFields.
import { VaultConsoleApp } from './app/VaultConsoleApp.js';

void new VaultConsoleApp(window, globalThis.SullaVaultCustomFields).run();
