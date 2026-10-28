// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createStore } from 'vuex';

import * as ContainerEngine from '@pkg/store/container-engine';

type Listener = (event: any, ...args: any[]) => void;
const listeners: Record<string, Listener[]> = {};
let backendState = 'STARTING';

jest.unstable_mockModule('@pkg/utils/ipcRenderer', () => ({
  ipcRenderer: {
    on:             (channel: string, fn: Listener) => (listeners[channel] ||= []).push(fn),
    removeListener: (channel: string, fn: Listener) => {
      listeners[channel] = (listeners[channel] || []).filter(l => l !== fn);
    },
    send:     () => undefined,
    sendSync: (channel: string) => (channel === 'k8s-state' ? backendState : undefined),
    invoke:   () => Promise.resolve({}),
  },
}));
jest.unstable_mockModule('@pkg/utils/dockerClient', () => ({ default: () => undefined }));
jest.unstable_mockModule('@pkg/components/DockerShell.vue', () => ({ default: { render: () => null } }));
jest.unstable_mockModule('@pkg/components/settings/sections/DockerSection.vue', () => ({ default: { render: () => null } }));
jest.unstable_mockModule('@pkg/composables/preferences/useEngineSettings', () => ({
  useEngineSettings: () => ({ held: ref(false), error: ref(''), discardHeld: () => Promise.resolve() }),
}));

const { default: Docker } = await import('../Docker.vue');

const emit = (channel: string, ...args: any[]) => (listeners[channel] || []).forEach(fn => fn({}, ...args));

/** A Docker client that fails like the main process does before it registers the spawn handlers. */
function fakeClient() {
  const client = {
    ready:  false,
    docker: {
      listContainers: jest.fn(() => (client.ready
        ? Promise.resolve([{
          Id: 'abc', Names: ['/sulla_tools'], Image: 'sulla/tools', State: 'running', Status: 'Up 2 minutes', Labels: {}, Ports: {},
        }])
        : Promise.reject(new Error('No handler registered for \'extensions/spawn/blocking\'')))),
      listVolumes:       jest.fn(() => Promise.resolve(client.ready ? [{ Name: 'sulla-postgres', Driver: 'local', Mountpoint: '/v' }] : [])),
      listImages:        jest.fn(() => Promise.resolve([])),
      subscribeToEvents: jest.fn(() => ({ unsubscribe: () => undefined })),
      cli:               { exec: jest.fn(() => Promise.resolve({ stdout: '', parseJsonLines: () => [] })) },
    },
  };

  return client;
}

function makeStore() {
  return createStore<any>({
    modules: {
      'container-engine': { namespaced: true, ...ContainerEngine } as any,
      preferences:        {
        namespaced: true,
        state:      { initialPreferences: { containerEngine: { name: 'moby' } } },
        actions:    { fetchPreferences: () => undefined, fetchLocked: () => undefined },
      },
      credentials: { namespaced: true, actions: { fetchCredentials: () => undefined } },
      snapshots:   { namespaced: true, getters: { list: () => [] }, actions: { fetch: () => undefined } },
    },
  });
}

let client: ReturnType<typeof fakeClient>;

beforeEach(() => {
  jest.useFakeTimers();
  for (const key of Object.keys(listeners)) {
    delete listeners[key];
  }
  client = fakeClient();
  (window as any).ddClient = client;
});
afterEach(() => {
  jest.useRealTimers();
  delete (window as any).ddClient;
});

describe('Docker tab', () => {
  it('connects once the backend is ready, after being restored at launch', async() => {
    backendState = 'STARTING';
    const store = makeStore();
    const wrapper = mount(Docker, { global: { plugins: [store] } });

    await flushPromises();
    expect(store.state['container-engine'].containers).toBeNull();

    // The Sulla runtime reports DISABLED when ready, then the spawn handlers are registered.
    client.ready = true;
    emit('k8s-check-state', 'DISABLED');
    emit('extensions/changed');
    await flushPromises();

    expect(Object.keys(store.state['container-engine'].containers)).toEqual(['abc']);
    expect(Object.keys(store.state['container-engine'].volumes)).toEqual(['sulla-postgres']);
    expect(wrapper.text()).toContain('Docker is running');
    wrapper.unmount();
  });

  it('keeps retrying while Docker has not answered yet', async() => {
    backendState = '';
    const store = makeStore();
    const wrapper = mount(Docker, { global: { plugins: [store] } });

    await flushPromises();
    expect(store.state['container-engine'].containers).toBeNull();
    client.ready = true;
    jest.advanceTimersByTime(5000);
    await flushPromises();

    expect(Object.keys(store.state['container-engine'].containers)).toEqual(['abc']);
    wrapper.unmount();
  });

  it('loading volumes does not clear the container list', async() => {
    backendState = 'DISABLED';
    client.ready = true;
    const store = makeStore();
    const wrapper = mount(Docker, { global: { plugins: [store] } });

    await flushPromises();
    jest.advanceTimersByTime(5000);
    await flushPromises();

    expect(Object.keys(store.state['container-engine'].containers)).toEqual(['abc']);
    expect(Object.keys(store.state['container-engine'].volumes)).toEqual(['sulla-postgres']);
    expect(wrapper.text()).toContain('sulla_tools');
    wrapper.unmount();
  });
});
