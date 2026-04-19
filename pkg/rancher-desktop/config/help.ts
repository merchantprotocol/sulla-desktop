import { TransientSettings } from '@pkg/config/transientSettings';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

type Paths = Record<string, string>;

class Url {
  private readonly baseUrl = 'https://sulladesktop.com/docs';
  private paths: Paths = {};

  constructor(paths: Paths) {
    this.paths = paths;
  }

  buildUrl(key: string | undefined, _version: string): string {
    if (key) {
      return `${ this.baseUrl }/${ this.paths[key] }`;
    }

    return '';
  }
}

class PreferencesHelp {
  private readonly url = new Url({
    'Application-behavior':            'ui/preferences/application/behavior',
    'Application-environment':         'ui/preferences/application/environment',
    'Application-general':             'ui/preferences/application/general',
    'Virtual Machine-hardware':        'ui/preferences/virtual-machine/hardware',
    'Virtual Machine-volumes':         'ui/preferences/virtual-machine/volumes',
    'Virtual Machine-network':         'ui/preferences/virtual-machine/network',
    'Virtual Machine-emulation':       'ui/preferences/virtual-machine/emulation',
    'Container Engine-general':        'ui/preferences/container-engine/general',
    'Container Engine-allowed-images': 'ui/preferences/container-engine/allowed-images',
    'WSL-integrations':                'ui/preferences/wsl/integrations',
    'WSL-network':                     'ui/preferences/wsl/network',
    'WSL-proxy':                       'ui/preferences/wsl/proxy',
    Kubernetes:                        'ui/preferences/kubernetes',
  });

  openUrl(version: string): void {
    const { current, currentTabs } = TransientSettings.value.preferences.navItem;
    const tab = currentTabs[current] ? `-${ currentTabs[current] }` : '';

    const url = this.url.buildUrl(`${ current }${ tab }`, version);

    ipcRenderer.send('open-url-in-app', url);
  }
}

export const Help = { preferences: new PreferencesHelp() };
