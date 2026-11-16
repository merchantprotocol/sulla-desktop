// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ServiceSecretRepository } from '../Repositories/ServiceSecretRepository';
import { ServiceSecretGenerator } from '../Services/ServiceSecret/ServiceSecretGenerator';
import { ServiceSecretProvider, SystemServiceSecretClock } from '../Services/ServiceSecret/ServiceSecretProvider';
import { SullaSettingsModel } from '../../database/models/SullaSettingsModel';

/** Wires the install service secret: settings-backed repository, generator and provider. */
export class ServiceSecretServiceProvider {
  readonly repository = new ServiceSecretRepository(SullaSettingsModel, console);
  readonly generator = new ServiceSecretGenerator();
  readonly provider = new ServiceSecretProvider(this.repository, this.generator, new SystemServiceSecretClock(), console);
}

export const serviceSecretServiceProvider = new ServiceSecretServiceProvider();
export const serviceSecretProvider = serviceSecretServiceProvider.provider;
