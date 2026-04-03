<template>
  <div
    class="h-full overflow-y-auto font-sans page-root"
    :class="{ dark: isDark }"
  >
    <PostHogTracker page-name="AgentAutomations" />
    <div class="flex min-h-full flex-col">
      <AgentHeader
        :is-dark="isDark"
        :toggle-theme="toggleTheme"
      />

      <div class="flex-1 overflow-auto">
        <div class="mx-auto max-w-6xl px-4 py-8">
          <!-- Back button -->
          <button
            class="mb-6 flex items-center gap-2 text-sm text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
            @click="$router.push('/Chat')"
          >
            <svg
              class="h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M15 19l-7-7 7-7"
              />
            </svg>
            Back to Chat
          </button>

          <div class="grid grid-cols-1 gap-8 lg:grid-cols-3">
            <!-- Main Content -->
            <div class="lg:col-span-2 space-y-8">
              <!-- Header -->
              <div class="flex items-start gap-6">
                <div class="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl bg-slate-100 dark:bg-slate-800">
                  <img
                    :src="require('@pkg/assets/images/n8n.svg')"
                    alt="N8N"
                    class="h-12 w-12 object-contain"
                  >
                </div>
                <div class="flex-1">
                  <h1 class="text-3xl font-bold text-slate-900 dark:text-white mb-2">
                    N8N
                  </h1>
                  <p class="text-lg text-slate-600 dark:text-slate-300 mb-4">
                    Powerful workflow automation platform for connecting apps and services
                  </p>
                  <div class="flex items-center gap-4">
                    <span class="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-sm font-medium text-slate-800 dark:bg-slate-700 dark:text-slate-200">
                      Automation
                    </span>
                    <div class="flex items-center gap-2">
                      <div class="h-2 w-2 rounded-full bg-green-500" />
                      <span class="text-xs text-slate-500 dark:text-slate-400">
                        Available
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Connect/Open Card -->
              <div class="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-slate-800">
                <h3 class="text-lg font-semibold text-slate-900 dark:text-white mb-4">
                  Access N8N Dashboard
                </h3>

                <div class="space-y-4">
                  <button
                    class="w-full rounded-lg px-4 py-2 text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors flex items-center justify-center"
                    @click="openN8N"
                  >
                    Open N8N Dashboard
                  </button>
                  <p class="text-xs text-slate-500 dark:text-slate-400">
                    Opens N8N in your default web browser at localhost:30119
                  </p>
                </div>
              </div>
            </div>

            <!-- Sidebar -->
            <div class="lg:col-span-2 space-y-8">
              <!-- Additional Resources -->
              <div class="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-slate-800">
                <h3 class="text-lg font-semibold text-slate-900 dark:text-white mb-4">
                  Resources
                </h3>
                <div class="space-y-3">
                  <a
                    href="https://docs.n8n.io/getting-started/"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="flex items-center justify-between rounded-lg border border-gray-200 p-4 hover:bg-slate-50 dark:border-gray-700 dark:hover:bg-slate-800"
                  >
                    <div class="flex items-center gap-3">
                      <div class="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-700">
                        <svg
                          class="h-4 w-4 text-slate-600 dark:text-slate-400"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.746 0 3.332.477 4.5 1.253v13C19.832 18.477 18.246 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
                          />
                        </svg>
                      </div>
                      <div>
                        <h4 class="font-medium text-slate-900 dark:text-white text-sm">Getting Started Guide</h4>
                        <p class="text-xs text-slate-600 dark:text-slate-400">Step-by-step introduction to N8N</p>
                      </div>
                    </div>
                    <svg
                      class="h-4 w-4 text-slate-400 flex-shrink-0"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                      />
                    </svg>
                  </a>

                  <a
                    href="https://n8n.io/workflows/"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="flex items-center justify-between rounded-lg border border-gray-200 p-4 hover:bg-slate-50 dark:border-gray-700 dark:hover:bg-slate-800"
                  >
                    <div class="flex items-center gap-3">
                      <div class="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-700">
                        <svg
                          class="h-4 w-4 text-slate-600 dark:text-slate-400"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                          />
                        </svg>
                      </div>
                      <div>
                        <h4 class="font-medium text-slate-900 dark:text-white text-sm">Workflow Templates</h4>
                        <p class="text-xs text-slate-600 dark:text-slate-400">Ready-to-use workflow examples</p>
                      </div>
                    </div>
                    <svg
                      class="h-4 w-4 text-slate-400 flex-shrink-0"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                      />
                    </svg>
                  </a>

                  <a
                    href="https://docs.n8n.io/"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="flex items-center justify-between rounded-lg border border-gray-200 p-4 hover:bg-slate-50 dark:border-gray-700 dark:hover:bg-slate-800"
                  >
                    <div class="flex items-center gap-3">
                      <div class="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-700">
                        <svg
                          class="h-4 w-4 text-slate-600 dark:text-slate-400"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                          />
                        </svg>
                      </div>
                      <div>
                        <h4 class="font-medium text-slate-900 dark:text-white text-sm">Official Documentation</h4>
                        <p class="text-xs text-slate-600 dark:text-slate-400">Complete guide and API reference</p>
                      </div>
                    </div>
                    <svg
                      class="h-4 w-4 text-slate-400 flex-shrink-0"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                      />
                    </svg>
                  </a>

                  <a
                    href="https://community.n8n.io/"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="flex items-center justify-between rounded-lg border border-gray-200 p-4 hover:bg-slate-50 dark:border-gray-700 dark:hover:bg-slate-800"
                  >
                    <div class="flex items-center gap-3">
                      <div class="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-700">
                        <svg
                          class="h-4 w-4 text-slate-600 dark:text-slate-400"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                          />
                        </svg>
                      </div>
                      <div>
                        <h4 class="font-medium text-slate-900 dark:text-white text-sm">Community Forum</h4>
                        <p class="text-xs text-slate-600 dark:text-slate-400">Get help and share workflows</p>
                      </div>
                    </div>
                    <svg
                      class="h-4 w-4 text-slate-400 flex-shrink-0"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                      />
                    </svg>
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ipcRenderer } from 'electron';
import AgentHeader from './agent/AgentHeader.vue';
import PostHogTracker from '@pkg/components/PostHogTracker.vue';
import { useTheme } from '@pkg/composables/useTheme';

const { isDark, toggleTheme, currentTheme, setTheme, availableThemes, themeGroups } = useTheme();

const openN8N = () => {
  const n8nUrl = 'http://127.0.0.1:30119';

  ipcRenderer.send('open-url-in-app', n8nUrl);
};
</script>

<style scoped>
.page-root {
  background: var(--bg-page);
  color: var(--text-primary);
}
</style>
