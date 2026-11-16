// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { inject, provide } from 'vue';

import { useFilesExplorerInteractions } from '../composables/useFilesExplorerInteractions';
import { useFilesOperationQueue } from '../composables/useFilesOperationQueue';
import { FilesBrowserController } from './FilesBrowserController';

import type { FilesBrowserEmit, FilesBrowserProps } from './FilesBrowserTypes';

/**
 * Thin Vue binding for FilesBrowser.vue: one controller per component instance, its watchers and lifecycle
 * registered in setup, and provided to the browser's child components.
 */
export function useFilesBrowser(props:FilesBrowserProps, emit:FilesBrowserEmit):FilesBrowserController {
  const explorer = useFilesExplorerInteractions(props.tabId);
  const operations = useFilesOperationQueue(props.dataSource, props.tabId);
  const browser = new FilesBrowserController(props, emit, explorer, operations);

  browser.lifecycle.bind();
  provide(FilesBrowserController.injectionKey, browser);
  return browser;
}

/** The FilesBrowser controller of the enclosing FilesBrowser.vue (child components only). */
export function injectFilesBrowser():FilesBrowserController {
  const browser = inject(FilesBrowserController.injectionKey);

  if (!browser) throw new Error('Files browser components must be rendered inside FilesBrowser.vue.');
  return browser;
}
