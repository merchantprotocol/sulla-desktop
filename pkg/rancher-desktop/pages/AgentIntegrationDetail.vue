<template>
  <div class="min-h-screen bg-white text-sm text-[#0d0d0d] dark:bg-slate-900 dark:text-neutral-50 font-sans" :class="{ dark: isDark }">
    <PostHogTracker page-name="AgentIntegrationDetail" />
    <div class="flex min-h-screen flex-col">
      <AgentHeader :is-dark="isDark" :toggle-theme="toggleTheme" />

      <div class="flex-1 overflow-auto">
        <div class="mx-auto max-w-6xl px-4 py-8">
          <!-- Back button -->
          <button
            @click="$router.push('/Integrations')"
            class="mb-6 flex items-center gap-2 text-sm text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
          >
            <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
            Back to Integrations
          </button>

          <div v-if="integration" class="grid grid-cols-1 gap-8 lg:grid-cols-2">
            <!-- Main Content -->
            <div class="lg:col-span-2 space-y-8">
              <!-- Media -->
              <div v-if="integration.media && integration.media.length > 0" class="space-y-4">
                <div class="relative">
                  <!-- Carousel Container -->
                  <div class="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
                    <div class="relative">
                      <!-- Main Media -->
                      <div class="aspect-video">
                        <!-- YouTube Video -->
                        <YouTubePlayer
                          v-if="integration.media[currentImageIndex].type === 'youtube'"
                          :video-id="integration.media[currentImageIndex].url"
                          :title="integration.media[currentImageIndex].alt"
                          :alt="integration.media[currentImageIndex].alt"
                        />
                        <!-- Image -->
                        <img
                          v-else-if="resolveMediaSrc(integration.media[currentImageIndex].url)"
                          :src="resolveMediaSrc(integration.media[currentImageIndex].url)"
                          :alt="integration.media[currentImageIndex].alt"
                          class="h-full w-full object-cover"
                        >
                        <div v-else class="flex h-full w-full items-center justify-center bg-slate-100 dark:bg-slate-800">
                          <span class="text-sm text-slate-400">Image unavailable</span>
                        </div>
                        <div v-if="integration.media[currentImageIndex].caption" class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-4">
                          <p class="text-sm text-white">{{ integration.media[currentImageIndex].caption }}</p>
                        </div>
                      </div>
                      
                      <!-- Navigation Arrows -->
                      <button
                        v-if="integration.media.length > 1"
                        @click="previousImage"
                        class="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70 transition-colors"
                      >
                        <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
                        </svg>
                      </button>
                      <button
                        v-if="integration.media.length > 1"
                        @click="nextImage"
                        class="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70 transition-colors"
                      >
                        <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  
                  <!-- Thumbnail Navigation -->
                  <div v-if="integration.media.length > 1" class="mt-4 flex gap-2 overflow-x-auto justify-end">
                    <button
                      v-for="(image, index) in integration.media"
                      :key="index"
                      @click="currentImageIndex = index"
                      class="flex-shrink-0 overflow-hidden rounded-lg border-2 transition-all"
                      :class="currentImageIndex === index ? 'border-blue-500' : 'border-gray-200 dark:border-gray-700'"
                    >
                      <img
                        :src="image.type === 'youtube' ? `https://img.youtube.com/vi/${image.url}/hqdefault.jpg` : (resolveMediaSrc(image.url) || '')"
                        :alt="image.alt"
                        class="h-16 w-24 object-cover"
                      >
                    </button>
                  </div>
                </div>
              </div>

              <!-- Header -->
              <div class="flex items-start gap-6">
                <div class="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl bg-slate-100 dark:bg-slate-800">
                  <img
                    v-if="isImageIcon(integration.icon) && safeIconSrc(integration.icon!)"
                    :src="safeIconSrc(integration.icon!)"
                    :alt="integration.name"
                    class="h-12 w-12 object-contain"
                  >
                  <span v-else class="text-3xl">{{ isImageIcon(integration.icon) ? '🔌' : integration.icon }}</span>
                </div>
                <div class="flex-1">
                  <h1 class="text-3xl font-bold text-slate-900 dark:text-white mb-2">
                    {{ integration.name }}
                  </h1>
                  <p class="text-lg text-slate-600 dark:text-slate-300 mb-4">
                    {{ integration.description }}
                  </p>
                  <div class="flex items-center gap-4">
                    <span class="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-sm font-medium text-slate-800 dark:bg-slate-700 dark:text-slate-200">
                      {{ integration.category }}
                    </span>
                    <div class="flex items-center gap-2">
                      <div
                        class="h-2 w-2 rounded-full"
                        :class="integration.connected ? 'bg-green-500' : 'bg-gray-300'"
                      ></div>
                      <span class="text-xs text-slate-500 dark:text-slate-400">
                        {{ integration.connected
                          ? (connectedAccounts.length > 1
                            ? `${connectedAccounts.length} accounts connected`
                            : (connectedAccounts.length === 1 ? `Connected to ${connectedAccounts[0].label}` : 'Connected'))
                          : 'Disconnected' }}
                      </span>
                      <!-- Beta/Coming Soon Badges -->
                      <div class="flex gap-1 ml-2">
                        <span
                          v-if="integration.beta"
                          class="inline-flex items-center rounded-full bg-blue-500 text-white text-xs px-2 py-0.5 font-medium"
                        >
                          BETA
                        </span>
                        <span
                          v-if="integration.comingSoon"
                          class="inline-flex items-center rounded-full bg-orange-500 text-white text-xs px-2 py-0.5 font-medium"
                        >
                          COMING SOON
                        </span>
                      </div>
                    </div>
                  </div>
                  <div class="flex items-center gap-1 text-sm text-slate-500 dark:text-slate-400">
                    <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <span>Updated {{ formatFuzzyTime(integration.lastUpdated) }}</span>
                  </div>
                </div>
              </div>

              <!-- Features -->
              <!-- <div class="space-y-4">
                <h2 class="text-xl font-semibold text-slate-900 dark:text-white">Features</h2>
                <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div
                    v-for="feature in integration.features"
                    :key="feature.title"
                    class="flex gap-3 rounded-lg border border-gray-200 p-4 dark:border-gray-700"
                  >
                    <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400">
                      <svg class="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
                        <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                      </svg>
                    </div>
                    <div>
                      <h3 class="font-medium text-slate-900 dark:text-white">{{ feature.title }}</h3>
                      <p class="text-sm text-slate-600 dark:text-slate-400">{{ feature.description }}</p>
                    </div>
                  </div>
                </div>
              </div> -->

              <!-- Connected Accounts List -->
              <div v-if="connectedAccounts.length > 0" class="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-slate-800">
                <div class="flex items-center justify-between mb-4">
                  <h3 class="text-lg font-semibold text-slate-900 dark:text-white">
                    Connected Accounts
                  </h3>
                  <button
                    @click="startAddAccount"
                    class="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 transition-colors"
                  >
                    <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" /></svg>
                    Add Another Account
                  </button>
                </div>

                <div class="space-y-3">
                  <div
                    v-for="acct in connectedAccounts"
                    :key="acct.account_id"
                    class="flex items-center justify-between rounded-lg border p-4 transition-colors"
                    :class="acct.active
                      ? 'border-blue-200 bg-blue-50/50 dark:border-blue-800 dark:bg-blue-900/20'
                      : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-slate-800'"
                  >
                    <div class="flex items-center gap-3">
                      <div class="h-2.5 w-2.5 rounded-full bg-green-500"></div>
                      <div>
                        <div class="flex items-center gap-2">
                          <span class="text-sm font-medium text-slate-900 dark:text-white">Connected to {{ acct.label }}</span>
                          <span v-if="acct.active" class="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">ACTIVE</span>
                        </div>
                        <p v-if="acct.connected_at" class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                          Since {{ new Date(acct.connected_at).toLocaleDateString() }}
                        </p>
                      </div>
                    </div>
                    <div class="flex items-center gap-2">
                      <button
                        @click="startEditAccount(acct.account_id)"
                        class="rounded-md px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-700 transition-colors"
                      >
                        Edit Credentials
                      </button>
                      <button
                        v-if="!acct.active"
                        @click="setAccountActive(acct.account_id)"
                        class="rounded-md px-2.5 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-900/20 transition-colors"
                      >
                        Set Active
                      </button>
                      <button
                        @click="disconnectAccount(acct.account_id)"
                        class="rounded-md px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20 transition-colors"
                      >
                        Disconnect
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Connect Card (first time or adding new account) -->
              <div v-if="showConnectionForm" class="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-slate-800">
                <div class="flex items-center justify-between mb-4">
                  <h3 class="text-lg font-semibold text-slate-900 dark:text-white">
                    {{ isEditingAccount
                      ? `Edit Credentials${editingAccountLabel ? ` (${editingAccountLabel})` : ''}`
                      : (connectedAccounts.length > 0 ? 'Add Another Account' : 'Connect Integration') }}
                  </h3>
                  <button
                    v-if="isAddingAccount || isEditingAccount"
                    @click="cancelAddAccount"
                    class="text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 font-medium"
                  >
                    Cancel
                  </button>
                </div>
                
                <!-- Form Guide -->
                <div v-if="integration.formGuide" class="mb-6">
                  <p class="text-sm text-slate-600 dark:text-slate-400">
                    <span class="font-medium">Where to find this information:</span> {{ integration.formGuide }}
                  </p>
                </div>

                <!-- OAuth sign-in section (completely independent of credentials form) -->
                <div v-if="(integration.authType === 'oauth' || integration.oauth) && !isEditingAccount" class="space-y-2 mb-6">
                  <button
                    @click="handleOAuthConnect()"
                    :disabled="isLoading"
                    class="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 flex items-center justify-center"
                  >
                    <svg v-if="isLoading" class="animate-spin h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24">
                      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a8 8 0 01-16 0v4a8 8 0 0016 0z"></path>
                    </svg>
                    {{ isLoading ? 'Authorizing...' : `Sign in with ${integration.name}` }}
                  </button>
                  <p class="text-xs text-slate-500 dark:text-slate-400">
                    Your browser will open to sign in and authorize access.
                  </p>
                  <p v-if="oauthError" class="text-xs text-red-500">{{ oauthError }}</p>
                </div>

                <!-- Divider when both OAuth and credentials are available -->
                <div v-if="integration.oauth && integration.authType !== 'oauth' && !isEditingAccount" class="flex items-center gap-3 mb-6">
                  <div class="flex-1 border-t border-slate-300 dark:border-slate-600"></div>
                  <span class="text-xs text-slate-400 dark:text-slate-500 uppercase">or connect with credentials</span>
                  <div class="flex-1 border-t border-slate-300 dark:border-slate-600"></div>
                </div>

                <!-- Credentials section (account label + properties + connect button) -->
                <div v-if="integration.authType !== 'oauth' || isEditingAccount">
                  <!-- Account Label (required only for new accounts) -->
                  <div v-if="connectedAccounts.length === 0 || isAddingAccount" class="space-y-2 mb-4">
                    <label for="__account_label" class="block text-sm font-medium text-slate-700 dark:text-slate-300">
                      Account Label
                      <span class="text-red-500">*</span>
                    </label>
                    <input
                      id="__account_label"
                      type="text"
                      v-model="newAccountLabel"
                      placeholder="e.g. Work Gmail, Personal Gmail, Team Slack"
                      class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-blue-500 dark:border-gray-600 dark:bg-slate-700 dark:text-white"
                      :class="{ 'border-red-500': errors['__account_label'] }"
                    >
                    <p class="text-xs text-slate-500 dark:text-slate-400">
                      A friendly name to identify this account (e.g. your email address or team name)
                    </p>
                    <p v-if="errors['__account_label']" class="text-xs text-red-500">
                      {{ errors['__account_label'] }}
                    </p>
                  </div>
                  
                  <!-- Configuration Form (credential fields) -->
                  <div v-if="integration.properties && integration.properties.length > 0" class="space-y-4 mb-6">
                    <div v-for="property in integration.properties" :key="property.key" class="space-y-2">
                      <label :for="property.key" class="block text-sm font-medium text-slate-700 dark:text-slate-300">
                        {{ property.title }}
                        <span v-if="property.required" class="text-red-500">*</span>
                      </label>

                      <!-- Select field -->
                      <div v-if="property.type === 'select'" class="relative">
                        <select
                          :id="property.key"
                          v-model="formData[property.key]"
                          :required="property.required"
                          class="w-full appearance-none rounded-lg border border-gray-300 px-3 py-2 pr-8 text-sm focus:border-blue-500 focus:ring-blue-500 dark:border-gray-600 dark:bg-slate-700 dark:text-white"
                          :class="{ 'border-red-500': errors[property.key] }"
                        >
                          <option value="" disabled>{{ selectOptionsLoading[property.key] ? 'Loading...' : property.placeholder || 'Select...' }}</option>
                          <option
                            v-for="opt in (selectOptions[property.key] || [])"
                            :key="opt.value"
                            :value="opt.value"
                          >
                            {{ opt.label }}{{ opt.description ? ` — ${opt.description}` : '' }}
                          </option>
                        </select>
                        <div class="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2">
                          <svg class="h-4 w-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                          </svg>
                        </div>
                        <button
                          v-if="property.selectBoxId && !selectOptionsLoading[property.key]"
                          type="button"
                          class="absolute right-7 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                          title="Refresh options"
                          @click="fetchSelectOptions(property)"
                        >
                          <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                        </button>
                      </div>

                      <!-- Standard input field -->
                      <input
                        v-else
                        :id="property.key"
                        :type="property.type"
                        v-model="formData[property.key]"
                        :placeholder="property.placeholder"
                        :required="property.required"
                        class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-blue-500 dark:border-gray-600 dark:bg-slate-700 dark:text-white"
                        :class="{ 'border-red-500': errors[property.key] }"
                        @blur="onDependencyFieldBlur(property.key)"
                      >
                      <p v-if="property.hint" class="text-xs text-slate-500 dark:text-slate-400">
                        {{ property.hint }}
                      </p>
                      <p v-if="errors[property.key]" class="text-xs text-red-500">
                        {{ errors[property.key] }}
                      </p>
                    </div>
                  </div>
                  
                  <div class="space-y-2">
                    <button
                      @click="handleConnect()"
                      :disabled="isLoading"
                      class="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 flex items-center justify-center"
                    >
                      <svg v-if="isLoading" class="animate-spin h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a8 8 0 01-16 0v4a8 8 0 0016 0z"></path>
                      </svg>
                      {{ isLoading
                        ? (isEditingAccount ? 'Saving...' : 'Connecting...')
                        : (isEditingAccount ? 'Save Changes' : 'Connect Now') }}
                    </button>
                    <p class="text-xs text-slate-500 dark:text-slate-400">
                      {{ isEditingAccount
                        ? 'Update and save credentials for this connected account'
                        : 'Connect your account to start using this integration' }}
                    </p>
                  </div>
                </div>
              </div>

              <!-- Guide Links -->
              <!-- <div v-if="integration.guideLinks && integration.guideLinks.length > 0" class="space-y-4">
                <h2 class="text-xl font-semibold text-slate-900 dark:text-white">Guides & Documentation</h2>
                <div class="space-y-3">
                  <a
                    v-for="link in integration.guideLinks"
                    :key="link.url"
                    :href="link.url"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="flex items-center justify-between rounded-lg border border-gray-200 p-4 hover:bg-slate-50 dark:border-gray-700 dark:hover:bg-slate-800"
                  >
                    <div class="flex items-center gap-3">
                      <div class="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-700">
                        <svg class="h-4 w-4 text-slate-600 dark:text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                      </div>
                      <div>
                        <h3 class="font-medium text-slate-900 dark:text-white">{{ link.title }}</h3>
                        <p class="text-sm text-slate-600 dark:text-slate-400">{{ link.description }}</p>
                      </div>
                    </div>
                    <svg class="h-4 w-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                </div>
              </div> -->
            </div>

            <!-- Sidebar -->
            <div class="lg:col-span-2 space-y-8">
              <!-- Installation Guide and Resources Row -->
              <div class="grid grid-cols-1 lg:grid-cols-12 gap-8">
                <!-- Installation Guide - 70% width (8 columns) -->
                <div class="lg:col-span-8">
                  <div v-if="integration.installationGuide" class="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-slate-800">
                    <h3 class="text-lg font-semibold text-slate-900 dark:text-white mb-4">{{ integration.installationGuide.title }}</h3>
                    <p class="text-sm text-slate-600 dark:text-slate-300 mb-6">{{ integration.installationGuide.description }}</p>
                    
                    <div class="space-y-6">
                      <div
                        v-for="(step, index) in integration.installationGuide.steps"
                        :key="index"
                        class="border-l-2 border-blue-200 dark:border-blue-800 pl-4"
                      >
                        <div class="flex items-center gap-2 mb-2">
                          <div class="flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-white text-xs font-medium">
                            {{ index + 1 }}
                          </div>
                          <h4 class="font-medium text-slate-900 dark:text-white">{{ step.title }}</h4>
                        </div>
                        <div class="prose prose-sm max-w-none dark:prose-invert">
                          <div class="whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-300 leading-relaxed">{{ step.content }}</div>
                        </div>
                      </div>
                    </div>
                    
                    <div v-if="integration.installationGuide.importantNotes && integration.installationGuide.importantNotes.length > 0" class="mt-6 p-4 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-800">
                      <h5 class="font-medium text-amber-900 dark:text-amber-100 mb-2">Important Notes</h5>
                      <ul class="space-y-1 text-sm text-amber-800 dark:text-amber-200">
                        <li v-for="(note, index) in integration.installationGuide.importantNotes" :key="index" class="flex items-start gap-2">
                          <svg class="h-4 w-4 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                            <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd" />
                          </svg>
                          {{ note }}
                        </li>
                      </ul>
                    </div>
                  </div>
                </div>

                <!-- Right Column - 30% width (4 columns) -->
                <div class="lg:col-span-4 space-y-8">
                  <!-- Additional Resources -->
                  <div v-if="integration.guideLinks && integration.guideLinks.length > 0" class="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-slate-800">
                    <h3 class="text-lg font-semibold text-slate-900 dark:text-white mb-4">Additional Resources</h3>
                    <div class="space-y-3">
                      <a
                        v-for="link in integration.guideLinks"
                        :key="link.url"
                        :href="link.url"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="flex items-center justify-between rounded-lg border border-gray-200 p-4 hover:bg-slate-50 dark:border-gray-700 dark:hover:bg-slate-800"
                      >
                        <div class="flex items-center gap-3">
                          <div class="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-700">
                            <svg class="h-4 w-4 text-slate-600 dark:text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                          </div>
                          <div>
                            <h4 class="font-medium text-slate-900 dark:text-white text-sm">{{ link.title }}</h4>
                            <p class="text-xs text-slate-600 dark:text-slate-400">{{ link.description }}</p>
                          </div>
                        </div>
                        <svg class="h-4 w-4 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                      </a>
                    </div>
                  </div>

                  <!-- Quick Info -->
                  <div class="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-slate-800">
                    <h3 class="text-lg font-semibold text-slate-900 dark:text-white mb-4">Quick Info</h3>
                    <div class="space-y-3">
                      <div>
                        <p class="text-xs font-medium text-slate-500 dark:text-slate-400">Category</p>
                        <p class="text-sm text-slate-900 dark:text-white">{{ integration.category }}</p>
                      </div>
                      <div>
                        <p class="text-xs font-medium text-slate-500 dark:text-slate-400">Version</p>
                        <p class="text-sm text-slate-900 dark:text-white">{{ integration.version || '1.0.0' }}</p>
                      </div>
                      <div>
                        <p class="text-xs font-medium text-slate-500 dark:text-slate-400">Last Updated</p>
                        <p class="text-sm text-slate-900 dark:text-white capitalize">{{ formatFuzzyTime(integration.lastUpdated) }}</p>
                      </div>
                      <div>
                        <p class="text-xs font-medium text-slate-500 dark:text-slate-400">Developer</p>
                        <p class="text-sm text-slate-900 dark:text-white">{{ integration.developer }}</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Support -->
              <!-- <div class="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-slate-800">
                <h3 class="text-lg font-semibold text-slate-900 dark:text-white mb-4">Need Help?</h3>
                <div class="space-y-3">
                  <a
                    href="#"
                    class="flex items-center gap-3 text-sm text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
                  >
                    <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    Help Center
                  </a>
                  <a
                    href="#"
                    class="flex items-center gap-3 text-sm text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
                  >
                    <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                    </svg>
                    Contact Support
                  </a>
                </div>
              </div> -->
            </div>
          </div>

          <!-- Loading State -->
          <div v-else class="flex h-64 items-center justify-center">
            <div class="text-center">
              <div class="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600"></div>
              <p class="text-sm text-slate-600 dark:text-slate-400">Loading integration details...</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import AgentHeader from './agent/AgentHeader.vue';
import PostHogTracker from '@pkg/components/PostHogTracker.vue';
import { integrations, type Integration } from '@pkg/agent/integrations/catalog';
import YouTubePlayer from '@pkg/components/YouTubePlayer.vue';
import { getIntegrationService } from '@pkg/agent/services/IntegrationService';
import { getExtensionService } from '@pkg/agent/services/ExtensionService';
import { formatFuzzyTime } from '@pkg/utils/dateFormat';

import type { IntegrationAccount } from '@pkg/agent/services/IntegrationService';
import { onMounted, ref, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

const THEME_STORAGE_KEY = 'agentTheme';
const isDark = ref(false);
const route = useRoute();
const router = useRouter();
const integrationService = getIntegrationService();

/** Safely resolve an integration icon/media path — returns null if the asset doesn't exist */
function safeIconSrc(path: string): string | null {
  try {
    return require(`@pkg/assets/images/${path}`);
  } catch {
    return null;
  }
}

function isImageIcon(icon?: string): boolean {
  if (!icon) return false;
  return /\.(svg|png|avif|jpg|jpeg|webp)$/i.test(icon);
}

function resolveMediaSrc(url: string): string | null {
  if (url.startsWith('http')) return url;
  return safeIconSrc(url);
}

const integration = ref<Integration | null>(null);
const mergedIntegrations = ref<Record<string, Integration>>({});
const currentImageIndex = ref(0);
const formData = ref<Record<string, string>>({});
const errors = ref<Record<string, string>>({});
const isLoading = ref(false);

// Select box state
const selectOptions = ref<Record<string, Array<{ value: string; label: string; description?: string }>>>({});
const selectOptionsLoading = ref<Record<string, boolean>>({});

// Multi-account state
const accounts = ref<IntegrationAccount[]>([]);
const selectedAccountId = ref('default');
const activeAccountId = ref('default');
const isAddingAccount = ref(false);
const isEditingAccount = ref(false);
const editingAccountId = ref<string | null>(null);
const newAccountLabel = ref('');
const oauthError = ref('');

/** Only accounts that are connected */
const connectedAccounts = computed(() => accounts.value.filter(a => a.connected));

/** Label for the account currently being edited */
const editingAccountLabel = computed(() => {
  if (!editingAccountId.value) return '';

  return accounts.value.find(a => a.account_id === editingAccountId.value)?.label ?? editingAccountId.value;
});

/** Show the connection form when: no accounts connected yet, OR user clicked "Add Another Account" */
const showConnectionForm = computed(() => connectedAccounts.value.length === 0 || isAddingAccount.value || isEditingAccount.value);

// Carousel functions
const nextImage = () => {
  if (integration.value && integration.value.media) {
    currentImageIndex.value = (currentImageIndex.value + 1) % integration.value.media.length;
  }
};

const previousImage = () => {
  if (integration.value && integration.value.media) {
    currentImageIndex.value = currentImageIndex.value === 0 
      ? integration.value.media.length - 1 
      : currentImageIndex.value - 1;
  }
};

const toggleTheme = () => {
  isDark.value = !isDark.value;
  localStorage.setItem(THEME_STORAGE_KEY, isDark.value ? 'dark' : 'light');
};

const refreshAccounts = async () => {
  if (!integration.value) return;
  accounts.value = await integrationService.getAccounts(integration.value.id);
  activeAccountId.value = await integrationService.getActiveAccountId(integration.value.id);
};

const startAddAccount = () => {
  isAddingAccount.value = true;
  isEditingAccount.value = false;
  editingAccountId.value = null;
  newAccountLabel.value = '';
  formData.value = {};
  errors.value = {};
};

const cancelAddAccount = () => {
  isAddingAccount.value = false;
  isEditingAccount.value = false;
  editingAccountId.value = null;
  newAccountLabel.value = '';
  formData.value = {};
  errors.value = {};
};

const loadFormDataForAccount = async (integrationId: string, accountId: string) => {
  const formValues = await integrationService.getFormValues(integrationId, accountId);
  const formDataObj: Record<string, string> = {};

  formValues.forEach(value => {
    formDataObj[value.property] = value.value;
  });

  selectedAccountId.value = accountId;
  formData.value = formDataObj;
  fetchAllSelectOptions();
};

const startEditAccount = async (accountId: string) => {
  if (!integration.value) return;

  isLoading.value = true;
  try {
    isAddingAccount.value = false;
    isEditingAccount.value = true;
    editingAccountId.value = accountId;
    newAccountLabel.value = '';
    errors.value = {};

    await loadFormDataForAccount(integration.value.id, accountId);
  } catch (error) {
    console.error('Failed to load account credentials for editing:', error);
  } finally {
    isLoading.value = false;
  }
};

/** Set a specific account as the active one */
const setAccountActive = async (accountId: string) => {
  if (!integration.value) return;
  await integrationService.setActiveAccount(integration.value.id, accountId);
  await refreshAccounts();
};

/** Disconnect (and delete) a specific account */
const disconnectAccount = async (accountId: string) => {
  if (!integration.value) return;
  isLoading.value = true;
  try {
    // For OAuth integrations, revoke tokens first
    if (integration.value.authType === 'oauth' || integration.value.oauth) {
      try {
        await integrationService.revokeOAuthTokens(integration.value.id, accountId);
      } catch (err) {
        console.warn('OAuth token revocation failed (continuing with disconnect):', err);
      }
    }
    await integrationService.deleteAccount(integration.value.id, accountId);
    await refreshAccounts();
    integration.value.connected = await integrationService.isAnyAccountConnected(integration.value.id);
    mergedIntegrations.value[integration.value.id].connected = integration.value.connected;
  } catch (error) {
    console.error('Failed to disconnect account:', error);
  } finally {
    isLoading.value = false;
  }
};

// ─── Select box helpers ─────────────────────────────────────────

/** Fetch options for a single select property from IntegrationService */
const fetchSelectOptions = async (property: { key: string; selectBoxId?: string; selectDependsOn?: string[] }) => {
  if (!integration.value || !property.selectBoxId) return;

  selectOptionsLoading.value[property.key] = true;
  try {
    const depValues: Record<string, string> = {};
    for (const depKey of (property.selectDependsOn ?? [])) {
      if (formData.value[depKey]) {
        depValues[depKey] = formData.value[depKey];
      }
    }

    const options = await integrationService.getSelectOptions(
      property.selectBoxId,
      integration.value.id,
      selectedAccountId.value,
      depValues,
    );
    selectOptions.value[property.key] = options;
  } catch (err) {
    console.error(`Failed to fetch select options for ${ property.key }:`, err);
    selectOptions.value[property.key] = [];
  } finally {
    selectOptionsLoading.value[property.key] = false;
  }
};

/** When a dependency field loses focus, refresh any select properties that depend on it */
const onDependencyFieldBlur = (changedKey: string) => {
  if (!integration.value?.properties) return;

  for (const prop of integration.value.properties) {
    if (prop.type === 'select' && prop.selectDependsOn?.includes(changedKey)) {
      fetchSelectOptions(prop);
    }
  }
};

/** Auto-fetch options for all select properties on mount */
const fetchAllSelectOptions = () => {
  if (!integration.value?.properties) return;

  for (const prop of integration.value.properties) {
    if (prop.type === 'select' && prop.selectBoxId) {
      fetchSelectOptions(prop);
    }
  }
};

// Validation functions
const validateField = (property: any, value: string): string | null => {
  if (property.required && (!value || value.trim() === '')) {
    return `${property.title} is required`;
  }
  
  if (!value) return null;
  
  if (property.validation) {
    const { pattern, minLength, maxLength, min, max } = property.validation;
    
    if (pattern && !new RegExp(pattern).test(value)) {
      return `${property.title} format is invalid`;
    }
    
    if (minLength && value.length < minLength) {
      return `${property.title} must be at least ${minLength} characters`;
    }
    
    if (maxLength && value.length > maxLength) {
      return `${property.title} must be no more than ${maxLength} characters`;
    }
    
    if (property.type === 'number') {
      const numValue = Number(value);
      if (min !== undefined && numValue < min) {
        return `${property.title} must be at least ${min}`;
      }
      if (max !== undefined && numValue > max) {
        return `${property.title} must be no more than ${max}`;
      }
    }
  }
  
  return null;
};

const validateForm = (): boolean => {
  if (!integration.value?.properties) return true;
  
  errors.value = {};
  let isValid = true;
  
  for (const property of integration.value.properties) {
    const error = validateField(property, formData.value[property.key] || '');
    if (error) {
      errors.value[property.key] = error;
      isValid = false;
    }
  }
  
  return isValid;
};

const handleOAuthConnect = async () => {
  if (!integration.value) return;

  errors.value = {};
  oauthError.value = '';

  // OAuth connections use a fixed account id — no label needed
  const targetAccountId = 'oauth';

  // Only check for client_id/client_secret when the integration is
  // authType 'oauth' (OAuth-only with user-supplied credentials like Google).
  let clientId = '';
  let clientSecret = '';

  if (integration.value.authType === 'oauth') {
    const props = integration.value.properties ?? [];
    const hasClientIdProp = props.some(p => p.key === 'client_id');
    const hasClientSecretProp = props.some(p => p.key === 'client_secret');

    if (hasClientIdProp && hasClientSecretProp) {
      clientId = formData.value['client_id'] || '';
      clientSecret = formData.value['client_secret'] || '';

      if (!clientId || !clientSecret) {
        oauthError.value = 'Client ID and Client Secret are required for OAuth connection.';
        return;
      }
    }
  }

  isLoading.value = true;
  try {
    await integrationService.setAccountLabel(integration.value.id, targetAccountId, integration.value.name + ' OAuth');

    // Start the OAuth flow — this opens the browser and waits for callback
    await integrationService.startOAuthFlow(
      integration.value.id,
      integration.value.oauthProviderId!,
      clientId,
      clientSecret,
      targetAccountId,
    );

    // Set the OAuth account as active
    await integrationService.setActiveAccount(integration.value.id, targetAccountId);

    await refreshAccounts();
    integration.value.connected = await integrationService.isAnyAccountConnected(integration.value.id);
    mergedIntegrations.value[integration.value.id].connected = integration.value.connected;
  } catch (error: any) {
    console.error('OAuth connection failed:', error);
    oauthError.value = error?.message || 'OAuth authorization failed. Please try again.';
  } finally {
    isLoading.value = false;
  }
};

const handleConnect = async () => {
  if (!integration.value) return;

  errors.value = {};

  const isCreatingAccount = connectedAccounts.value.length === 0 || isAddingAccount.value;
  const label = newAccountLabel.value.trim();

  if (isCreatingAccount && !label) {
    errors.value['__account_label'] = 'Account label is required';

    return;
  }

  const targetAccountId = isCreatingAccount
    ? label.toLowerCase().replace(/[^a-z0-9]+/g, '_')
    : (editingAccountId.value || selectedAccountId.value || activeAccountId.value);

  // Validate credential fields
  if (!validateForm()) return;

  isLoading.value = true;
  try {
    if (isCreatingAccount) {
      // Save label for new account
      await integrationService.setAccountLabel(integration.value.id, targetAccountId, label);
    }

    // Save credential fields for this account (new or existing)
    const formInputs = Object.entries(formData.value).map(([key, value]) => ({
      integration_id: integration.value!.id,
      account_id: targetAccountId,
      property: key,
      value: value
    }));
    await integrationService.setFormValues(formInputs);

    if (isCreatingAccount) {
      // Mark newly created account connected
      await integrationService.setConnectionStatus(integration.value.id, true, targetAccountId);
    }

    // If this is the first account, set it as active
    if (isCreatingAccount && connectedAccounts.value.length === 0) {
      await integrationService.setActiveAccount(integration.value.id, targetAccountId);
    }

    // Reset form state
    isAddingAccount.value = false;
    isEditingAccount.value = false;
    editingAccountId.value = null;
    newAccountLabel.value = '';
    formData.value = {};

    await refreshAccounts();
    integration.value.connected = await integrationService.isAnyAccountConnected(integration.value.id);
    mergedIntegrations.value[integration.value.id].connected = integration.value.connected;
  } catch (error) {
    console.error('Failed to save integration configuration:', error);
  } finally {
    isLoading.value = false;
  }
};

onMounted(async () => {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    isDark.value = saved === 'dark';
  } catch {
    isDark.value = false;
  }

  // Initialize integration service
  await integrationService.initialize();

  const extensionService = getExtensionService();
  await extensionService.initialize();

  const extensionIntegrations = extensionService.getExtensionIntegrations();
  mergedIntegrations.value = { ...integrations };
  for (const extInt of extensionIntegrations) {
    mergedIntegrations.value[extInt.id] = extInt;
  }

  // Load integration data based on route parameter
  const integrationId = route.params.id as string;
  integration.value = mergedIntegrations.value[integrationId] || null;

  // If integration not found, redirect back to integrations list
  if (!integration.value) {
    router.push('/Integrations');
    return;
  }

  // Load accounts and form data
  try {
    await refreshAccounts();
    selectedAccountId.value = activeAccountId.value;

    await loadFormDataForAccount(integrationId, selectedAccountId.value);
    
    // Load connection status (check any account)
    integration.value.connected = await integrationService.isAnyAccountConnected(integrationId);
    mergedIntegrations.value[integrationId].connected = integration.value.connected;

  } catch (error) {
    console.error('Failed to load integration data:', error);
  }
});
</script>

<style scoped>
/* Custom styles for integration detail page */
.aspect-video {
  aspect-ratio: 16 / 9;
}
</style>
