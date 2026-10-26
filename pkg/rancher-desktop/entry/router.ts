import { createRouter, createWebHashHistory, RouteRecordRaw } from 'vue-router';

import AgentRoutines from '../pages/AgentRoutines.vue';
import DenyRoot from '../pages/DenyRoot.vue';
import Docker from '../pages/Docker.vue';
import Dialog from '../pages/Dialog.vue';
import FirstRun from '../pages/FirstRun.vue';
import KubernetesError from '../pages/KubernetesError.vue';
import Preferences from '../pages/Preferences.vue';
import RoutinesHome from '../pages/RoutinesHome.vue';
import SudoPrompt from '../pages/SudoPrompt.vue';
import Troubleshooting from '../pages/Troubleshooting.vue';
import UnmetPrerequisites from '../pages/UnmetPrerequisites.vue';
import Usage from '../pages/Usage.vue';
import ExtensionsItem from '../pages/extensions/_root/_src/_id.vue';
import ImagesAdd from '../pages/images/add.vue';
import ImagesScan from '../pages/images/scans/_image-name.vue';
import SnapshotsCreate from '../pages/snapshots/create.vue';
import SnapshotsDialog from '../pages/snapshots/dialog.vue';
import VolumeFiles from '../pages/volumes/files/_name.vue';
import FilesPreviewHarness from '../pages/files/FilesPreviewHarness.vue';

export default createRouter({
  history: createWebHashHistory(),
  routes:  [
    { path: '/', redirect: '/Containers' },
    { path: '/Containers', component: Docker, name: 'Containers', meta: { dockerSection: 'containers' } },
    { path: '/containers/info/:id', component: Docker, name: 'container-info', meta: { dockerSection: 'container' } },
    { path: '/Images', component: Docker, name: 'Images', meta: { dockerSection: 'images' } },
    { path: '/Volumes', component: Docker, name: 'Volumes', meta: { dockerSection: 'volumes' } },
    { path: '/Networks', component: Docker, name: 'Networks', meta: { dockerSection: 'networks' } },
    { path: '/Ports', component: Docker, name: 'Ports', meta: { dockerSection: 'ports' } },
    { path: '/PortForwarding', redirect: '/Ports' },
    { path: '/Snapshots', component: Docker, name: 'Snapshots', meta: { dockerSection: 'snapshots' } },
    { path: '/DockerOptions', component: Docker, name: 'Options', meta: { dockerSection: 'options' } },
    {
      path: '/Usage', component: Usage, name: 'Usage',
    },
    {
      path: '/volumes/files/:name', component: VolumeFiles, name: 'volumes-files-name',
    },
    {
      path: '/images/add', component: ImagesAdd, name: 'images-add',
    },
    {
      path: '/images/scans/:image-name?/:namespace?', component: ImagesScan, name: 'images-scans-image-name',
    },
    {
      path: '/snapshots/create', component: SnapshotsCreate, name: 'snapshots-create',
    },
    {
      path: '/Troubleshooting', component: Troubleshooting, name: 'Troubleshooting',
    },
    {
      path: '/extensions/:id/:root(.*)/:src', component: ExtensionsItem, name: 'rdx-root-src-id',
    },
    {
      path: '/DenyRoot', component: DenyRoot, name: 'DenyRoot',
    },
    {
      path: '/FirstRun', component: FirstRun, name: 'FirstRun',
    },
    {
      path: '/KubernetesError', component: KubernetesError, name: 'KubernetesError',
    },
    {
      path: '/preferences', component: Preferences, name: 'Preferences',
    },
    {
      path: '/Dialog', component: Dialog, name: 'Dialog',
    },
    {
      path: '/SudoPrompt', component: SudoPrompt, name: 'SudoPrompt',
    },
    {
      path: '/UnmetPrerequisites', component: UnmetPrerequisites, name: 'UnmetPrerequisites',
    },
    {
      path: '/SnapshotsDialog', component: SnapshotsDialog, name: 'SnapshotsDialog',
    },
    {
      path: '/routines', component: RoutinesHome, name: 'routines',
    },
    {
      path: '/routines/:id', component: AgentRoutines, name: 'routines-edit', props: true,
    },
    {
      path: '/files-preview', component: FilesPreviewHarness, name: 'files-preview',
    },
  ],
});
