// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { dockerRunner } from './dockerHost';
import { DesktopManagedServicesHooks } from './linuxDesktopHooks';
import { LinuxManagedServices, LinuxServicesComposeBuilder } from './linuxManagedServices';

/**
 * Production wiring of the managed services to Desktop's events, settings and
 * on-demand runtimes. Every Desktop module is imported lazily, at the moment it
 * is needed, so constructing a backend (and its unit tests) stays light.
 */
export function createDesktopLinuxManagedServices(): LinuxManagedServices {
  return new LinuxManagedServices({
    docker:  dockerRunner(15 * 60_000),
    builder: new LinuxServicesComposeBuilder(async() => {
      const [{ default: yaml }, { default: compose }] = await Promise.all([import('yaml'), import('@pkg/assets/sulla-docker-compose.yaml')]);

      return typeof compose === 'string' ? yaml.parse(compose) : compose;
    }),
    hooks: new DesktopManagedServicesHooks(
      { emit: event => void import('@pkg/main/mainEvents').then(({ default: mainEvents }) => mainEvents.emit(event)) },
      {
        markDockerServicesStarted: () => void import('@pkg/sulla').then(m => m.markSullaDockerServicesStarted()),
        instantiateStart:          async(assertCurrent) => (await import('@pkg/sulla')).instantiateSullaStart(assertCurrent),
        markInstalled:             async() => {
          const { SullaSettingsModel } = await import('@pkg/agent/database/models/SullaSettingsModel');

          await SullaSettingsModel.set('firstKubernetesIsInstalled', true, 'boolean');
        },
      },
    ),
    composeOptions: async(paths) => {
      const [{ SullaSettingsModel }, { hostPort }] = await Promise.all([
        import('@pkg/agent/database/models/SullaSettingsModel'), import('@pkg/utils/instance'),
      ]);

      return { paths, resolvePort: hostPort, servicePassword: await SullaSettingsModel.getServicePassword() };
    },
    configureOnDemand: run => void import('@pkg/backend/onDemandServices').then(m => m.configureOnDemandServices(run)),
    clearOnDemand:     () => void import('@pkg/backend/onDemandServices').then(m => m.clearOnDemandServices()),
  });
}
