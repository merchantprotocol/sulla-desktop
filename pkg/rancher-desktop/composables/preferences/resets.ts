import { ipcRenderer } from '@pkg/utils/ipcRenderer';

/** Ask, then reset Kubernetes. Checking the box also deletes container images. */
export async function confirmResetKubernetes(): Promise<void> {
  const result = await ipcRenderer.invoke('show-message-box', {
    type:            'warning',
    title:           'Reset Kubernetes',
    message:         'Reset Kubernetes?',
    detail:          'Deletes every workload and starts a fresh cluster. Docker images stay unless you also delete them.',
    checkboxLabel:   'Also delete container images',
    checkboxChecked: false,
    buttons:         ['Reset', 'Cancel'],
    cancelId:        1,
  });

  if (result.response === 0) {
    ipcRenderer.send('k8s-reset', result.checkboxChecked ? 'wipe' : 'fast');
  }
}

/** Ask, then remove all containers, images, settings and Sulla data on this computer. */
export async function confirmFactoryReset(): Promise<void> {
  const result = await ipcRenderer.invoke('show-message-box', {
    type:            'warning',
    title:           'Factory reset',
    message:         'Reset Sulla Desktop to factory settings?',
    detail:          'This removes all containers, images, settings and Sulla data on this computer, then quits Sulla. It can’t be undone.',
    checkboxLabel:   'Keep cached system images',
    checkboxChecked: false,
    buttons:         ['Factory reset', 'Cancel'],
    cancelId:        1,
  });

  if (result.response === 0) {
    ipcRenderer.send('factory-reset', !!result.checkboxChecked);
  }
}
